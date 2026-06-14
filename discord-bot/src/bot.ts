/**
 * Discord runtime: the in-memory identity registry and the periodic re-sync
 * loop. RANK data comes from ENS (via {@link RankReader}); the bot makes ZERO
 * calibre-API *pulls*. IDENTITY arrives via a verified, signed push from
 * calibre (#582, see {@link createIdentityServer}) — there is no user-run
 * `/link` (it was manual and spoofable: anyone could claim any name).
 *
 * Demo-scoped (issue: "hosting beyond the demo window" is out of scope): the
 * `<discord member id> → <ens name>` registry lives in memory. A restart drops
 * it; calibre re-pushes on the next connect / the operator replays the pushes.
 */
import {
  type CategoryChannel,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  type Guild,
  PermissionFlagsBits,
  type TextChannel,
} from "discord.js";
import type { BotConfig } from "./config.js";
import {
  type DesiredChannel,
  desiredChannels,
  fetchPublicMarkets,
  fetchUpcomingMatches,
  isManagedMatchChannelName,
  pinnedMessageFor,
  reconcileChannels,
} from "./matches.js";
import type { RankReader } from "./rank.js";
import {
  LADDER_TIERS,
  TIER_STYLE,
  isTier,
  legacyRoleNameForTier,
  reconcileRoles,
  roleNameForTier,
  tierIndex,
} from "./roles.js";

/** Tiers that can see the rank-gated lounge channel. */
const LOUNGE_TIERS = ["Seer", "Oracle"] as const;

/** Role colour for a tier label, falling back to the floor colour for unknowns. */
function tierColor(tier: string | null): number {
  return tier && isTier(tier) ? TIER_STYLE[tier].color : TIER_STYLE.Static.color;
}

/** In-memory member→ENS-name registry. Demo-scoped (no persistence).
 * Populated by the verified identity push (#582), not by users. */
export type LinkRegistry = Map<string, string>;

/**
 * Ensure the per-tier managed roles exist in the guild, returning a name→roleId
 * map. Roles are created on demand so the demo guild needs no manual setup.
 */
async function ensureManagedRoles(guild: Guild): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  await guild.roles.fetch();
  for (const tier of LADDER_TIERS) {
    const name = roleNameForTier(tier);
    const legacy = legacyRoleNameForTier(tier);
    const style = TIER_STYLE[tier];
    // Match the bare name or the pre-rename `calibre:<Tier>` so an existing role
    // is restyled/renamed in place — never orphaned into a bare-named duplicate.
    let role = guild.roles.cache.find((r) => r.name === name || r.name === legacy);
    if (!role) {
      role = await guild.roles.create({
        name,
        color: style.color,
        hoist: style.hoist,
        reason: "calibre rank role",
      });
    } else if (role.name !== name || role.color !== style.color || role.hoist !== style.hoist) {
      role = await role.edit({
        name,
        color: style.color,
        hoist: style.hoist,
        reason: "calibre rank role restyle",
      });
    }
    // Unicode role icon is best-effort: it requires guild Boost level 2
    // (ROLE_ICONS feature). On guilds without it setUnicodeEmoji rejects, so
    // swallow the error — colour + hoist + name still land.
    if (style.emoji && role.unicodeEmoji !== style.emoji) {
      try {
        await role.setUnicodeEmoji(style.emoji, "calibre rank role icon");
      } catch {
        // not boosted enough for role icons.
      }
    }
    byName.set(name, role.id);
  }
  return byName;
}

/**
 * Apply the rank-derived role for one member: resolve their linked name's rank
 * FROM ENS and reconcile their managed roles. Never throws on a normal ENS
 * miss — an unresolvable/unset name removes managed roles (no rank role).
 */
export async function syncMember(
  guild: Guild,
  memberId: string,
  ensName: string,
  ranks: RankReader,
  roleIds: Map<string, string>,
): Promise<{ tier: string | null; added: string[]; removed: string[] }> {
  const member = await guild.members.fetch(memberId);
  const tier = await ranks.rankOf(ensName);
  const current = member.roles.cache.map((r) => r.name);
  const delta = reconcileRoles(current, tier);

  for (const name of delta.add) {
    const id = roleIds.get(name);
    if (id) await member.roles.add(id, "calibre rank sync");
  }
  for (const name of delta.remove) {
    const id = roleIds.get(name);
    if (id) await member.roles.remove(id, "calibre rank sync");
  }
  return { tier, added: delta.add, removed: delta.remove };
}

/** Build (but don't log in) the bot. Exposed for wiring + the start loop. */
export function createBot(config: BotConfig, ranks: RankReader) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  const links: LinkRegistry = new Map();
  let roleIds: Map<string, string> | null = null;
  // Last tier we observed per member, so a reconcile that crosses *upward* fires
  // a one-time promotion shout-out. Demo-scoped (in-memory, like the link map).
  const lastTier = new Map<string, string | null>();

  async function guild(): Promise<Guild> {
    return client.guilds.fetch(config.guildId);
  }

  /** Find an existing text channel by name, else create it (needs Manage Channels). */
  async function ensureTextChannel(g: Guild, name: string): Promise<TextChannel | null> {
    await g.channels.fetch();
    const existing = g.channels.cache.find(
      (c) => c?.type === ChannelType.GuildText && c.name === name,
    ) as TextChannel | undefined;
    if (existing) return existing;
    try {
      return await g.channels.create({ name, type: ChannelType.GuildText, reason: "calibre rank bot" });
    } catch (err) {
      console.error(`could not create #${name} — does the bot have the Manage Channels permission?`, err);
      return null;
    }
  }

  /** Resolve the shout-out channel: explicit id if configured, else the named one. */
  async function announceChannel(g: Guild): Promise<TextChannel | null> {
    if (config.announceChannelId) {
      const ch = await g.channels.fetch(config.announceChannelId).catch(() => null);
      return ch && ch.type === ChannelType.GuildText ? (ch as TextChannel) : null;
    }
    return ensureTextChannel(g, config.announceChannelName);
  }

  /** Create the Seer/Oracle-only lounge if it doesn't exist (idempotent). */
  async function ensureLounge(g: Guild, ids: Map<string, string>): Promise<void> {
    await g.channels.fetch();
    const name = config.loungeChannelName;
    if (g.channels.cache.find((c) => c?.type === ChannelType.GuildText && c.name === name)) return;
    const overwrites: { id: string; allow?: bigint[]; deny?: bigint[] }[] = [
      { id: g.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    ];
    for (const tier of LOUNGE_TIERS) {
      const id = ids.get(tier);
      if (id) overwrites.push({ id, allow: [PermissionFlagsBits.ViewChannel] });
    }
    if (client.user) {
      overwrites.push({
        id: client.user.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      });
    }
    try {
      await g.channels.create({
        name,
        type: ChannelType.GuildText,
        topic: "Seer & Oracle only — earned via your calibre rank.",
        permissionOverwrites: overwrites,
        reason: "calibre rank-gated lounge",
      });
    } catch (err) {
      console.error(`could not create #${name} — needs Manage Channels + bot role above the tier roles`, err);
    }
  }

  /** Post a promotion shout-out embed in the announce channel. */
  async function announcePromotion(g: Guild, memberId: string, from: string | null, to: string): Promise<void> {
    const ch = await announceChannel(g);
    if (!ch) return;
    const icon = isTier(to) ? `${TIER_STYLE[to].emoji} ` : "🏆 ";
    const embed = new EmbedBuilder()
      .setColor(tierColor(to))
      .setDescription(`${icon}<@${memberId}> climbed to **${to}**${from ? ` — up from ${from}` : ""}.`);
    try {
      await ch.send({ embeds: [embed] });
    } catch (err) {
      console.error("promotion announce failed", err);
    }
  }

  /** Reconcile a member's role and fire a shout-out if their tier crossed upward. */
  async function applyAndAnnounce(
    g: Guild,
    memberId: string,
    ensName: string,
    ids: Map<string, string>,
  ): Promise<{ tier: string | null }> {
    const r = await syncMember(g, memberId, ensName, ranks, ids);
    const prev = lastTier.get(memberId);
    lastTier.set(memberId, r.tier);
    // Only announce a genuine increase from a previously-known tier (never on the
    // first observation, and never on a demotion).
    if (prev !== undefined && tierIndex(r.tier) > tierIndex(prev)) {
      await announcePromotion(g, memberId, prev, r.tier as string);
    }
    return r;
  }

  /** Find a category channel by name, else create it (idempotent). */
  async function ensureCategory(g: Guild, name: string): Promise<CategoryChannel | null> {
    await g.channels.fetch();
    const existing = g.channels.cache.find(
      (c) => c?.type === ChannelType.GuildCategory && c.name === name,
    ) as CategoryChannel | undefined;
    if (existing) return existing;
    try {
      return await g.channels.create({
        name,
        type: ChannelType.GuildCategory,
        reason: "calibre match channels",
      });
    } catch (err) {
      console.error(`could not create category #${name} — does the bot have Manage Channels?`, err);
      return null;
    }
  }

  /** Upsert the pinned market message in a match channel (one managed pin). */
  async function upsertPin(channel: TextChannel, content: string): Promise<void> {
    try {
      const pins = await channel.messages.fetchPinned();
      const mine = pins.find((m) => m.author.id === client.user?.id);
      if (mine) {
        if (mine.content !== content) await mine.edit(content);
        return;
      }
      const msg = await channel.send(content);
      await msg.pin("calibre market link");
    } catch (err) {
      console.error(`could not pin in #${channel.name}`, err);
    }
  }

  /** Create one match channel under the managed category, then post + pin. */
  async function createMatchChannel(
    g: Guild,
    parentId: string,
    desired: DesiredChannel,
  ): Promise<void> {
    try {
      const channel = await g.channels.create({
        name: desired.name,
        type: ChannelType.GuildText,
        parent: parentId,
        topic: `${desired.match.team1} vs ${desired.match.team2}`,
        reason: "calibre per-match channel (#580)",
      });
      await upsertPin(channel, pinnedMessageFor(desired.match, desired.market, config.calibreApiBase));
    } catch (err) {
      console.error(`could not create match channel #${desired.name}`, err);
    }
  }

  /**
   * Reconcile per-match channels: pull public matches + markets, create one
   * channel per upcoming match (idempotent by deterministic name), refresh each
   * pin, and archive channels whose match has left the upcoming window. All
   * reads are public, no-auth. Errors are isolated so the role loop is unaffected.
   *
   * Managed = a bot-named (`-vs-…-<6hex>`) text channel under the active
   * category; only those are ever archived. Don't manually create a same-shaped
   * channel in the managed category — the bot would treat it as its own.
   */
  async function reconcileMatchChannels(): Promise<void> {
    let matches: Awaited<ReturnType<typeof fetchUpcomingMatches>>;
    let markets: Awaited<ReturnType<typeof fetchPublicMarkets>>;
    try {
      [matches, markets] = await Promise.all([
        fetchUpcomingMatches(config.calibreApiBase),
        fetchPublicMarkets(config.calibreApiBase),
      ]);
    } catch (err) {
      console.error("match-channel fetch failed — skipping this pass", err);
      return;
    }

    const g = await guild();
    const active = await ensureCategory(g, config.matchCategoryName);
    if (!active) return;

    await g.channels.fetch();
    // Managed = a per-match-named text channel currently under the active category.
    const managed: TextChannel[] = [];
    for (const c of g.channels.cache.values()) {
      if (
        c?.type === ChannelType.GuildText &&
        c.parentId === active.id &&
        isManagedMatchChannelName(c.name)
      ) {
        managed.push(c as TextChannel);
      }
    }
    const byName = new Map(managed.map((c) => [c.name, c]));

    const desired = desiredChannels(matches, markets);
    const plan = reconcileChannels(
      desired,
      managed.map((c) => c.name),
    );

    for (const d of plan.create) {
      await createMatchChannel(g, active.id, d);
    }
    for (const d of plan.keep) {
      const ch = byName.get(d.name);
      if (ch) await upsertPin(ch, pinnedMessageFor(d.match, d.market, config.calibreApiBase));
    }
    if (plan.archive.length > 0) {
      const archive = await ensureCategory(g, config.matchArchiveCategoryName);
      if (archive) {
        for (const name of plan.archive) {
          const ch = byName.get(name);
          if (ch) {
            try {
              await ch.setParent(archive.id, { lockPermissions: false, reason: "calibre match settled/expired" });
            } catch (err) {
              console.error(`could not archive #${name}`, err);
            }
          }
        }
      }
    }
  }

  /**
   * Apply a VERIFIED identity from the calibre push (#582): record
   * `memberId -> ensName` in the registry and immediately reconcile that one
   * member's role from ENS. Idempotent; errors propagate to the caller (the
   * ingest server maps them to a 500). This is the only writer of the registry
   * now that `/link` is gone — identity is always calibre-verified, never
   * self-asserted.
   */
  async function linkMember(memberId: string, ensName: string): Promise<void> {
    links.set(memberId, ensName);
    const g = await guild();
    roleIds ??= await ensureManagedRoles(g);
    await applyAndAnnounce(g, memberId, ensName, roleIds);
  }

  /** Re-resolve every linked member and reconcile roles. Errors per-member are isolated. */
  async function resyncAll(): Promise<void> {
    if (links.size === 0) return;
    const g = await guild();
    roleIds ??= await ensureManagedRoles(g);
    for (const [memberId, ensName] of links) {
      try {
        await applyAndAnnounce(g, memberId, ensName, roleIds);
      } catch {
        // A single member's failure (left guild, transient RPC) must not stall the loop.
      }
    }
  }

  async function start(): Promise<void> {
    // No slash commands: identity is pushed by calibre (#582), not user-run.

    // Apply role styling (names, colours, hoist, icons) as soon as we're online,
    // so a deploy converges the guild without waiting for the first push. If the
    // bot's role sits below the tier roles, the edits 403 — log a clear hint.
    client.once("ready", async () => {
      try {
        const g = await guild();
        roleIds = await ensureManagedRoles(g);
        // Best-effort channel setup — needs Manage Channels; failures are logged
        // (with a hint) and don't stop the bot from running role sync.
        if (!config.announceChannelId) await ensureTextChannel(g, config.announceChannelName);
        await ensureLounge(g, roleIds);
        // First match-channel reconcile on boot — isolated so a calibre/Discord
        // hiccup here never blocks role setup.
        await reconcileMatchChannels();
      } catch (err) {
        console.error(
          "setup on ready failed — check the bot's role position (above tiers) + Manage Channels permission",
          err,
        );
      }
    });

    await client.login(config.discordToken);
    setInterval(() => {
      void resyncAll();
      void reconcileMatchChannels();
    }, config.resyncIntervalMs);
  }

  return { client, links, start, resyncAll, reconcileMatchChannels, linkMember };
}
