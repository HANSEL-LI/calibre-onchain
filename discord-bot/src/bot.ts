/**
 * Discord runtime: the `/link` slash command, the in-memory link registry, and
 * the periodic re-sync loop. All rank data comes from ENS (via {@link
 * RankReader}); the bot makes ZERO calibre-API calls.
 *
 * Demo-scoped (issue: "hosting beyond the demo window" is out of scope): the
 * `<discord member id> → <ens name>` registry lives in memory. A restart drops
 * links; members re-`/link`.
 */
import {
  type ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  type Guild,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import type { BotConfig } from "./config.js";
import { isAcceptedName } from "./rank.js";
import type { RankReader } from "./rank.js";
import {
  LADDER_TIERS,
  TIER_STYLE,
  legacyRoleNameForTier,
  reconcileRoles,
  roleNameForTier,
} from "./roles.js";

export const LINK_COMMAND = new SlashCommandBuilder()
  .setName("link")
  .setDescription("Link your calibre ENS name; the bot reads your rank from ENS and assigns a role.")
  .addStringOption((o) =>
    o.setName("name").setDescription("e.g. demo.calibre.eth").setRequired(true),
  );

/** In-memory member→ENS-name registry. Demo-scoped (no persistence). */
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

  async function guild(): Promise<Guild> {
    return client.guilds.fetch(config.guildId);
  }

  async function handleLink(interaction: ChatInputCommandInteraction): Promise<void> {
    const name = (interaction.options.getString("name", true) ?? "").trim().toLowerCase();
    if (!isAcceptedName(name, config.ensParent)) {
      await interaction.reply({
        content: `That isn't a \`<name>.${config.ensParent}\` subname I can resolve.`,
        ephemeral: true,
      });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    links.set(interaction.user.id, name);
    const g = await guild();
    roleIds ??= await ensureManagedRoles(g);
    const r = await syncMember(g, interaction.user.id, name, ranks, roleIds);
    await interaction.editReply(
      r.tier
        ? `Linked \`${name}\` → rank **${r.tier}**.`
        : `Linked \`${name}\`, but it has no \`gg.calibre.rank\` record yet — no role assigned.`,
    );
  }

  /** Re-resolve every linked member and reconcile roles. Errors per-member are isolated. */
  async function resyncAll(): Promise<void> {
    if (links.size === 0) return;
    const g = await guild();
    roleIds ??= await ensureManagedRoles(g);
    for (const [memberId, ensName] of links) {
      try {
        await syncMember(g, memberId, ensName, ranks, roleIds);
      } catch {
        // A single member's failure (left guild, transient RPC) must not stall the loop.
      }
    }
  }

  async function start(): Promise<void> {
    const rest = new REST({ version: "10" }).setToken(config.discordToken);
    await rest.put(Routes.applicationGuildCommands(config.discordAppId, config.guildId), {
      body: [LINK_COMMAND.toJSON()],
    });

    client.on("interactionCreate", async (interaction) => {
      if (interaction.isChatInputCommand() && interaction.commandName === "link") {
        await handleLink(interaction);
      }
    });

    // Apply role styling (names, colours, hoist, icons) as soon as we're online,
    // so a deploy converges the guild without waiting for the first /link. If the
    // bot's role sits below the tier roles, the edits 403 — log a clear hint.
    client.once("ready", async () => {
      try {
        roleIds = await ensureManagedRoles(await guild());
      } catch (err) {
        console.error(
          "ensureManagedRoles failed on ready — is the bot's own role positioned ABOVE the tier roles?",
          err,
        );
      }
    });

    await client.login(config.discordToken);
    setInterval(() => {
      void resyncAll();
    }, config.resyncIntervalMs);
  }

  return { client, links, start, resyncAll };
}
