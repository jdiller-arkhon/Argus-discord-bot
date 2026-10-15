import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  ChannelType,
  type Client,
  EmbedBuilder,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  OverwriteType,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  ThreadAutoArchiveDuration,
} from 'discord.js';
import { Colors } from '../discord.js';
import { type ComponentHandler, customId, UserFacingError } from '../interactions.js';
import type { Logger } from '../logger.js';
import { nextStatus, type TicketAction } from './state.js';
import type { Ticket, TicketStore } from './store.js';

/** Max staff members explicitly added to a private ticket thread (the role is also @mentioned). */
const MAX_STAFF_THREAD_ADDS = 25;

export const TICKET_FIELDS = {
  subject: 'subject',
  description: 'description',
  reference: 'reference',
} as const;

export interface TicketFlowOptions {
  /** Product slug stored on each ticket, e.g. `argus`. */
  product: string;
  /** Display name, e.g. `Argus`. */
  productLabel: string;
  /** Custom ID prefix for the flow's buttons and modal. Default `ticket`. */
  prefix?: string;
  store: TicketStore;
  logger: Logger;
  /** Text channel that hosts private ticket threads. */
  supportChannelId: string;
  staffRoleId: string;
  /** `thread` (default) uses private threads in the support channel and falls back to `channel`. */
  mode?: 'thread' | 'channel';
  /** Category for private ticket channels (channel mode or fallback). */
  categoryId?: string;
  /** Where a summary is posted when a ticket closes. */
  archiveChannelId?: string;
  /** Label for the optional reference field in the modal, e.g. "Argus job ID (optional)". */
  referenceLabel?: string;
  color?: number;
  now?: () => Date;
}

export type StaffAction = Extract<TicketAction, 'claim' | 'markWaiting' | 'close'>;

export interface TicketFlow {
  /** Routes the flow's buttons and modal. Register with `createInteractionRouter`. */
  component: ComponentHandler;
  /** Button that opens the ticket modal; put it on any message. */
  openButton(label?: string): ButtonBuilder;
  /** Feed every guild message here: reopens waiting tickets and tracks first staff reply. */
  onMessage(message: Message): Promise<void>;
  /** Loads active ticket channels from the store; call once at startup. */
  loadActiveChannels(): Promise<number>;
}

function channelUrl(guildId: string, channelId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

export function ticketChannelName(ticketId: number, product: string, username: string): string {
  const slug = username
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${product}-${String(ticketId).padStart(4, '0')}-${slug || 'user'}`.slice(0, 100);
}

/** True for members holding the staff role, or administrators. */
export function isTicketStaff(member: GuildMember, staffRoleId: string): boolean {
  return member.permissions.has(PermissionFlagsBits.Administrator) || member.roles.cache.has(staffRoleId);
}

/**
 * The support ticket flow from the Ops bot, packaged so any bot can open
 * tickets: a modal (subject, description, optional reference), a private
 * thread in the support channel (or a private channel), staff controls
 * (claim / waiting on user / close), and automatic reopening when the user
 * replies to a ticket that is waiting on them.
 */
export function createTicketFlow(options: TicketFlowOptions): TicketFlow {
  const prefix = options.prefix ?? 'ticket';
  const now = options.now ?? (() => new Date());
  const color = options.color ?? Colors.primary;
  const { store, logger } = options;
  const activeChannels = new Set<string>();

  const ids = {
    open: customId(prefix, 'open'),
    modal: customId(prefix, 'modal'),
    claim: (id: number) => customId(prefix, 'claim', String(id)),
    waiting: (id: number) => customId(prefix, 'waiting', String(id)),
    close: (id: number) => customId(prefix, 'close', String(id)),
  };

  const buildModal = () => {
    const input = (id: string, label: string, style: TextInputStyle, min: number, max: number, required: boolean) =>
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setMinLength(min).setMaxLength(max).setRequired(required),
      );
    return new ModalBuilder()
      .setCustomId(ids.modal)
      .setTitle(`${options.productLabel} support ticket`)
      .addComponents(
        input(TICKET_FIELDS.subject, 'Subject', TextInputStyle.Short, 3, 100, true),
        input(TICKET_FIELDS.description, 'What is going on?', TextInputStyle.Paragraph, 10, 2000, true),
        input(TICKET_FIELDS.reference, options.referenceLabel ?? 'Reference (optional)', TextInputStyle.Short, 0, 64, false),
      );
  };

  const staffControls = (ticketId: number) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(ids.claim(ticketId)).setLabel('Claim').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(ids.waiting(ticketId)).setLabel('Waiting on user').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(ids.close(ticketId)).setLabel('Close').setStyle(ButtonStyle.Danger),
    );

  const activeTicketMessage = (ticket: Ticket) =>
    `You already have an open ${options.productLabel} ticket: ${channelUrl(ticket.guildId, ticket.channelId!)}`;

  async function showModal(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.inCachedGuild()) {
      throw new UserFacingError('Support tickets can only be opened from the server, not in DMs.');
    }
    const existing = await store.findActiveForUser(interaction.user.id, options.product);
    if (existing) throw new UserFacingError(activeTicketMessage(existing));
    await interaction.showModal(buildModal());
  }

  async function createFromModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.inCachedGuild()) {
      throw new UserFacingError('Support tickets can only be opened from the server, not in DMs.');
    }
    const member = interaction.member;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const existing = await store.findActiveForUser(member.id, options.product);
    if (existing) throw new UserFacingError(activeTicketMessage(existing));

    const subject = interaction.fields.getTextInputValue(TICKET_FIELDS.subject).trim();
    const description = interaction.fields.getTextInputValue(TICKET_FIELDS.description).trim();
    const reference = interaction.fields.getTextInputValue(TICKET_FIELDS.reference).trim() || null;

    const ticket = await store.create(
      { guildId: member.guild.id, product: options.product, userId: member.id, subject, description, reference },
      now(),
    );

    let channel: GuildTextBasedChannel;
    let kind: 'thread' | 'channel';
    try {
      ({ channel, kind } = await createTicketChannel(member, ticket.id));
    } catch (error) {
      await store.delete(ticket.id);
      throw error;
    }
    await store.setChannel(ticket.id, channel.id, kind);
    activeChannels.add(channel.id);

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`${options.productLabel} ticket #${ticket.id}: ${subject}`)
      .setDescription(description)
      .addFields(
        { name: 'Opened by', value: `${member}`, inline: true },
        { name: options.referenceLabel?.replace(/\s*\(optional\)$/i, '') ?? 'Reference', value: reference ?? 'not provided', inline: true },
        { name: 'Status', value: 'Open', inline: true },
      )
      .setTimestamp(now());
    await channel.send({
      content: `${member} thanks for reaching out. <@&${options.staffRoleId}> will be with you shortly.`,
      embeds: [embed],
      components: [staffControls(ticket.id)],
      allowedMentions: { users: [member.id], roles: [options.staffRoleId] },
    });

    logger.info('Ticket opened', { ticketId: ticket.id, product: options.product, userId: member.id, channelId: channel.id, kind });
    await interaction.editReply(`Your ticket is open: ${channel}`);
  }

  async function createTicketChannel(
    member: GuildMember,
    ticketId: number,
  ): Promise<{ channel: GuildTextBasedChannel; kind: 'thread' | 'channel' }> {
    const name = ticketChannelName(ticketId, options.product, member.user.username);
    if ((options.mode ?? 'thread') === 'thread') {
      const thread = await createPrivateThread(member, name).catch((error: unknown) => {
        logger.warn('Private thread unavailable, falling back to a private channel', { ticketId, error });
        return null;
      });
      if (thread) return { channel: thread, kind: 'thread' };
    }
    return { channel: await createPrivateChannel(member.guild, member, name), kind: 'channel' };
  }

  async function createPrivateThread(member: GuildMember, name: string): Promise<GuildTextBasedChannel> {
    const guild = member.guild;
    const support = await guild.channels.fetch(options.supportChannelId);
    if (!support || support.type !== ChannelType.GuildText) {
      throw new Error('The support channel must be a text channel to host private threads');
    }
    const me = guild.members.me;
    const perms = me ? support.permissionsFor(me) : null;
    if (!perms?.has([PermissionFlagsBits.CreatePrivateThreads, PermissionFlagsBits.SendMessagesInThreads])) {
      throw new Error('Bot lacks Create Private Threads / Send Messages in Threads in the support channel');
    }
    const thread = await support.threads.create({
      name,
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: `${options.productLabel} support ticket for ${member.user.tag}`,
    });
    await thread.members.add(member.id);

    // Private threads cannot be shared with a role directly. The opening
    // message @mentions the staff role, and cached staff are added explicitly.
    const staffRole = guild.roles.cache.get(options.staffRoleId);
    const staff = staffRole ? [...staffRole.members.values()].filter((m) => !m.user.bot) : [];
    for (const staffMember of staff.slice(0, MAX_STAFF_THREAD_ADDS)) {
      await thread.members.add(staffMember.id).catch((error: unknown) => {
        logger.warn('Could not add staff member to ticket thread', { userId: staffMember.id, error });
      });
    }
    return thread;
  }

  async function createPrivateChannel(guild: Guild, member: GuildMember, name: string): Promise<GuildTextBasedChannel> {
    const me = guild.members.me;
    if (!me) throw new Error('Bot member is not cached');
    const participant = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks,
    ];
    return guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: options.categoryId ?? null,
      topic: `${options.productLabel} support ticket for ${member.user.tag}`,
      reason: `${options.productLabel} support ticket for ${member.user.tag}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
        { id: member.id, type: OverwriteType.Member, allow: participant },
        { id: options.staffRoleId, type: OverwriteType.Role, allow: [...participant, PermissionFlagsBits.ManageMessages] },
        { id: me.id, type: OverwriteType.Member, allow: [...participant, PermissionFlagsBits.ManageChannels] },
      ],
    });
  }

  async function handleStaffAction(interaction: ButtonInteraction, action: StaffAction, ticketId: number): Promise<void> {
    const ticket = await store.get(ticketId);
    if (!ticket) throw new UserFacingError(`Ticket #${ticketId} no longer exists.`);
    if (!interaction.inCachedGuild() || !isTicketStaff(interaction.member, options.staffRoleId)) {
      throw new UserFacingError(`Only ${options.productLabel} staff can do that.`);
    }
    const staff = interaction.member;

    let to;
    try {
      to = nextStatus(ticket.status, action);
    } catch (error) {
      throw new UserFacingError((error as Error).message);
    }

    if (action === 'close') {
      await closeTicket(interaction, ticket, staff);
      return;
    }
    if (action === 'claim' && ticket.claimedById === staff.id) {
      throw new UserFacingError('You have already claimed this ticket.');
    }
    if (!(await store.transition(ticket.id, ticket.status, to, action === 'claim' ? staff.id : undefined))) {
      throw new UserFacingError('This ticket just changed. Please try again.');
    }

    logger.info('Ticket updated', { ticketId, action, from: ticket.status, to, staffId: staff.id });
    if (action === 'claim') {
      await interaction.reply({
        content: `🙋 ${staff} claimed this ticket${ticket.claimedById ? ` (previously <@${ticket.claimedById}>)` : ''}.`,
        allowedMentions: { parse: [] },
      });
    } else {
      await interaction.reply({
        content: `⏳ <@${ticket.userId}>, the team is waiting on your reply. The ticket reopens automatically when you respond.`,
        allowedMentions: { users: [ticket.userId] },
      });
    }
  }

  async function closeTicket(interaction: ButtonInteraction<'cached'>, ticket: Ticket, staff: GuildMember): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!(await store.close(ticket.id, staff.id, now()))) throw new UserFacingError('This ticket is already closed.');
    if (ticket.channelId) activeChannels.delete(ticket.channelId);

    const client: Client = interaction.client;
    const summary = new EmbedBuilder()
      .setColor(Colors.neutral)
      .setTitle(`${options.productLabel} ticket #${ticket.id} closed: ${ticket.subject}`)
      .addFields(
        { name: 'User', value: `<@${ticket.userId}>`, inline: true },
        { name: 'Claimed by', value: ticket.claimedById ? `<@${ticket.claimedById}>` : 'unclaimed', inline: true },
        { name: 'Closed by', value: `${staff}`, inline: true },
      )
      .setTimestamp(now());
    if (ticket.reference) summary.addFields({ name: 'Reference', value: ticket.reference, inline: true });

    const opener = await client.users.fetch(ticket.userId).catch(() => null);
    const dmDelivered = opener
      ? await opener
          .send({
            embeds: [
              new EmbedBuilder()
                .setColor(color)
                .setTitle(`Your ${options.productLabel} ticket #${ticket.id} was closed`)
                .setDescription(`**${ticket.subject}**\n\nIf you still need help, open a new ticket.`),
            ],
          })
          .then(() => true)
          .catch(() => false)
      : false;

    if (options.archiveChannelId) {
      const archive = await client.channels.fetch(options.archiveChannelId).catch(() => null);
      if (archive?.isSendable()) {
        await archive.send({ embeds: [summary], allowedMentions: { parse: [] } });
      } else {
        logger.error('Ticket archive channel unavailable', { channelId: options.archiveChannelId });
      }
    }

    logger.info('Ticket closed', { ticketId: ticket.id, staffId: staff.id, dmDelivered });
    await interaction.editReply(`Ticket closed.${dmDelivered ? ' The user was notified by DM.' : ''}`);

    const channel = interaction.channel;
    if (!channel) return;
    await channel.send({ content: `🔒 Ticket closed by ${staff}.`, allowedMentions: { parse: [] } });
    if (channel.isThread()) {
      await channel.setLocked(true, 'Ticket closed');
      await channel.setArchived(true, 'Ticket closed');
    } else {
      await channel.delete(`Ticket #${ticket.id} closed`);
    }
  }

  const staffActions: Record<string, StaffAction> = { claim: 'claim', waiting: 'markWaiting', close: 'close' };

  return {
    component: {
      prefix,
      async handleButton(interaction, [action, arg]) {
        if (action === 'open') return showModal(interaction);
        const staffAction = action ? staffActions[action] : undefined;
        const ticketId = Number(arg);
        if (staffAction && Number.isInteger(ticketId)) return handleStaffAction(interaction, staffAction, ticketId);
      },
      async handleModal(interaction, [action]) {
        if (action === 'modal') return createFromModal(interaction);
      },
    },
    openButton(label = `Open a ${options.productLabel} ticket`) {
      return new ButtonBuilder().setCustomId(ids.open).setLabel(label).setEmoji('🎫').setStyle(ButtonStyle.Primary);
    },
    async onMessage(message) {
      if (message.author.bot || !message.inGuild() || !activeChannels.has(message.channelId)) return;
      const ticket = await store.getByChannel(message.channelId);
      if (!ticket || ticket.status === 'closed') return;

      if (message.author.id === ticket.userId) {
        if (ticket.status === 'waiting' && (await store.transition(ticket.id, 'waiting', nextStatus('waiting', 'userReply')))) {
          logger.info('Ticket reopened by user reply', { ticketId: ticket.id });
        }
        return;
      }
      if (ticket.firstStaffReplyAt) return;
      const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
      if (member && isTicketStaff(member, options.staffRoleId)) await store.recordFirstStaffReply(ticket.id, message.createdAt);
    },
    async loadActiveChannels() {
      activeChannels.clear();
      for (const id of await store.activeChannelIds()) activeChannels.add(id);
      return activeChannels.size;
    },
  };
}
