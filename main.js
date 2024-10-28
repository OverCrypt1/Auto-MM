// main.js
require('dotenv').config(); // Import dotenv at the beginning
const { Mutex } = require('async-mutex');
const ticketMutexes = new Map();
const path = require('path'); // Import the path module



const {
    Client,
    GatewayIntentBits,
    Partials,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActivityType,
    PermissionFlagsBits,
    AttachmentBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    Collection,
} = require('discord.js');
const fs = require('fs').promises; // Use asynchronous file operations
const { createTranscript } = require('discord-html-transcripts');
const axios = require('axios');
const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');

// Define Litecoin network parameters
const litecoinNetwork = {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bech32: 'ltc',
    bip32: {
        public: 0x019da462,
        private: 0x019d9cfe,
    },
    pubKeyHash: 0x30,
    scriptHash: 0x32,
    wif: 0xb0,
};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// Use environment variables for sensitive information
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID;
const TRANSCRIPT_CHANNEL_ID = process.env.TRANSCRIPT_CHANNEL_ID;
const BLOCKCYPHER_TOKEN = process.env.BLOCKCYPHER_TOKEN;

// Load current deals from current.json or initialize an empty object
let currentDeals = {};
async function loadCurrentDeals() {
    try {
        const data = await fs.readFile('current.json', 'utf8');
        currentDeals = JSON.parse(data);
    } catch (err) {
        console.log('current.json not found or invalid, starting with an empty object.');
        currentDeals = {};
    }
}

// Load deal numbers from dealNumbers.json or initialize with the last deal number
let dealNumbers = { lastDealNumber: 0 };
async function loadDealNumbers() {
    try {
        const data = await fs.readFile('dealNumbers.json', 'utf8');
        dealNumbers = JSON.parse(data);
    } catch (err) {
        console.log('dealNumbers.json not found or invalid, starting with deal number 0.');
        dealNumbers = { lastDealNumber: 0 };
    }
}

// Map to keep track of ticket participants and data
const tickets = new Map();

// Load tickets from tickets.json
async function loadTickets() {
    try {
        const data = await fs.readFile('tickets.json', 'utf8');
        const ticketsData = JSON.parse(data);
        for (const [channelId, ticketData] of Object.entries(ticketsData)) {
            // Reconstruct Sets from Arrays
            if (Array.isArray(ticketData.data.roleConfirmedUsers)) {
                ticketData.data.roleConfirmedUsers = new Set(ticketData.data.roleConfirmedUsers);
            }
            if (Array.isArray(ticketData.data.agreedUsers)) {
                ticketData.data.agreedUsers = new Set(ticketData.data.agreedUsers);
            }
            if (Array.isArray(ticketData.data.amountConfirmedUsers)) {
                ticketData.data.amountConfirmedUsers = new Set(ticketData.data.amountConfirmedUsers);
            }
            if (Array.isArray(ticketData.data.cancelConfirmedUsers)) {
                ticketData.data.cancelConfirmedUsers = new Set(ticketData.data.cancelConfirmedUsers);
            }
            tickets.set(channelId, ticketData);
        }
        console.log('Tickets loaded from tickets.json.');
    } catch (err) {
        console.log('tickets.json not found or invalid, starting with an empty tickets Map.');
    }
}
function sanitizeUserId(input) {
    if (typeof input !== 'string') return '';
    return input.replace(/[<@!>]/g, '');
}


async function saveTicketsToFile() {
    const ticketsData = {};
    for (const [channelId, ticket] of tickets.entries()) {
        if (ticket.state !== 'closed') {
            // Convert Sets to Arrays for JSON serialization
            const ticketCopy = JSON.parse(JSON.stringify(ticket));
            if (ticketCopy.data.roleConfirmedUsers instanceof Set) {
                ticketCopy.data.roleConfirmedUsers = Array.from(ticketCopy.data.roleConfirmedUsers);
            }
            if (ticketCopy.data.agreedUsers instanceof Set) {
                ticketCopy.data.agreedUsers = Array.from(ticketCopy.data.agreedUsers);
            }
            if (ticketCopy.data.amountConfirmedUsers instanceof Set) {
                ticketCopy.data.amountConfirmedUsers = Array.from(ticketCopy.data.amountConfirmedUsers);
            }
            if (ticketCopy.data.cancelConfirmedUsers instanceof Set) {
                ticketCopy.data.cancelConfirmedUsers = Array.from(ticketCopy.data.cancelConfirmedUsers);
            }
            ticketsData[channelId] = ticketCopy;
        }
    }
    await fs.writeFile('tickets.json', JSON.stringify(ticketsData, null, 4));
}

// Initial data loading
// loadCurrentDeals();
// loadDealNumbers();
// loadTickets();

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    client.user.setActivity('Termwave ⚡ ', { type: ActivityType.Watching });
});


// Cache LTC prices to reduce API calls
let ltcPriceCache = null;
let lastPriceFetchTime = 0;
async function getLTCPrices() {
    const now = Date.now();
    if (ltcPriceCache && now - lastPriceFetchTime < 60000) {
        return ltcPriceCache;
    }
    try {
        const response = await axios.get(
            'https://api.coingecko.com/api/v3/simple/price',
            {
                params: {
                    ids: 'litecoin',
                    vs_currencies: 'usd,eur',
                },
                timeout: 10000,
            }
        );
        const ltcPriceUsd = response.data.litecoin.usd;
        const ltcPriceEur = response.data.litecoin.eur;
        ltcPriceCache = { ltcPriceUsd, ltcPriceEur };
        lastPriceFetchTime = now;
        return ltcPriceCache;
    } catch (error) {
        console.error('Error fetching LTC prices:', error.message);
        return { ltcPriceUsd: 0, ltcPriceEur: 0 };
    }
}

// Define the path to data.json
const DATA_FILE_PATH = path.join(__dirname, 'data.json');

// Initialize dashboard data
let dashboardData = {
    totalDeals: 0,
    succeededDeals: 0,
    refundedDeals: 0,
    totalUsd: 0,
    totalEur: 0,
    totalLtc: 0
};

const dashboardMutex = new Mutex();


// Function to load dashboard data
async function loadDashboardData() {
    try {
        const data = await fs.readFile(DATA_FILE_PATH, 'utf8');
        dashboardData = JSON.parse(data);
        console.log('Dashboard data loaded successfully.');
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.log('data.json not found. Initializing with default values.');
            await saveDashboardData(); // Create data.json with default values
        } else {
            console.error('Error loading data.json:', err);
        }
    }
}

// Function to save dashboard data
async function saveDashboardData() {
    try {
        await fs.writeFile(DATA_FILE_PATH, JSON.stringify(dashboardData, null, 4));
        console.log('Dashboard data saved successfully.');
    } catch (err) {
        console.error('Error saving data.json:', err);
    }
}

// Load dashboard data during initial data loading
loadCurrentDeals();
loadDealNumbers();
loadTickets();
loadDashboardData();

async function migrateExistingDeals() {
    try {
        // Load closed tickets
        let closedTickets = {};
        try {
            const data = await fs.readFile('closedTickets.json', 'utf8');
            closedTickets = JSON.parse(data);
        } catch (err) {
            console.log('closedTickets.json not found or invalid. No existing closed deals to migrate.');
            return;
        }

        for (const ticket of Object.values(closedTickets)) {
            if (ticket.state === 'released' || ticket.state === 'refunded') {
                dashboardData.totalDeals += 1;
                if (ticket.state === 'released') {
                    dashboardData.succeededDeals += 1;
                } else if (ticket.state === 'refunded') {
                    dashboardData.refundedDeals += 1;
                }
                dashboardData.totalUsd += parseFloat(ticket.data.amountUsd) || 0;
                dashboardData.totalLtc += parseFloat(ticket.data.ltcAmount) || 0;
            }
        }

        // Fetch latest LTC prices to calculate totalEur
        const { ltcPriceUsd, ltcPriceEur } = await getLTCPrices();
        dashboardData.totalEur = dashboardData.totalUsd * (ltcPriceEur / ltcPriceUsd);

        await saveDashboardData();
        console.log('Migration completed successfully.');
    } catch (error) {
        console.error('Error during migration:', error);
    }
}

client.on('messageCreate', async (message) => {
    // Command to set up the ticket system
    if (message.content === '.setupticket' && message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        const embed = new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle('Create a Ticket')
            .setDescription('# What is An Auto MM ? \n <a:rightarrow:1245672204096765973> It Is An Automatic Middlemann Service. Which Costs 0% Fee. This is made for the security of Move Shop Buyers. Always Use MM When Dealing With Anyone.\n# Is This Safe ? \n <a:rightarrow:1245672204096765973> Yes, Only the person who sent the money can send it to the receiver. The receiver can\'t take the money without the sender\'s permission. And you can contact support if you have any problems.\n# How To Use ? \n <a:vulkane:1282374309926404211> To get started Make the ticket. Rest Of The Information Is Present in : <#1286742440652312687>');

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('create_ticket')
                .setLabel('Create Auto MM')
                .setStyle(ButtonStyle.Primary)
        );

        await message.channel.send({ embeds: [embed], components: [row] });
    }

    if (message.content.toLowerCase() === '.ping') {
        const ping = client.ws.ping; // Bot's WebSocket latency
        message.channel.send(`🏓 Pong! Bot latency is ${ping}ms.`);
    }

    // Manual Release Command
    if (message.content.startsWith('.release') && message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        const args = message.content.split(' ');
        let ticket;

        // First, check if the command is used inside a ticket channel
        ticket = tickets.get(message.channel.id);
        if (ticket && ticket.state === 'awaiting_release') {
            // Use the ticket associated with the current channel
            await message.reply('Initiating manual release of funds for this ticket.');
            await sendFundsToSeller(message.channel, ticket);
        } else {
            // If not, proceed to find the ticket by userId
            const userId = args[1]?.replace(/[<@!>]/g, '');
            if (!userId) {
                await message.reply('Please mention the ticket owner to release funds.');
                return;
            }
            // Find the ticket for the user
            ticket = Array.from(tickets.values()).find(
                (t) => t.ownerId === userId && t.state === 'awaiting_release'
            );
            if (!ticket) {
                await message.reply('No active ticket found for the specified user.');
                return;
            }
            const channel = await client.channels.fetch(ticket.channelId);
            await message.reply('Initiating manual release of funds.');
            await sendFundsToSeller(channel, ticket);
        }
    }

    // Manual Cancel Command
    if (message.content.startsWith('.cancel') && message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        const args = message.content.split(' ');
        let ticket;

        // First, check if the command is used inside a ticket channel
        ticket = tickets.get(message.channel.id);
        if (ticket && ticket.state === 'awaiting_release') {
            // Use the ticket associated with the current channel
            await message.reply('Initiating manual cancellation for this ticket.');
            await refundBuyer(message.channel, ticket);
        } else {
            // If not, proceed to find the ticket by userId
            const userId = args[1]?.replace(/[<@!>]/g, '');
            if (!userId) {
                await message.reply('Please mention the ticket owner to cancel the transaction.');
                return;
            }
            // Find the ticket for the user
            ticket = Array.from(tickets.values()).find(
                (t) => t.ownerId === userId && t.state === 'awaiting_release'
            );
            if (!ticket) {
                await message.reply('No active ticket found for the specified user.');
                return;
            }
            const channel = await client.channels.fetch(ticket.channelId);
            await message.reply('Initiating manual cancellation.');
            await refundBuyer(channel, ticket);
        }
    }

    // Close Command
    if (message.content === '.close') {
        const ticket = tickets.get(message.channel.id);
        if (!ticket) {
            await message.reply('This command can only be used inside a ticket.');
            return;
        }
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator) && message.author.id !== ticket.ownerId) {
            await message.reply('You do not have permission to close this ticket.');
            return;
        }
        await closeTicket(message.channel, message.author);
    }

    if (message.content === '.dashboard' && message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        try {
            // Acquire the mutex before reading dashboardData
            const release = await dashboardMutex.acquire();
            try {
                // Recalculate totalEur based on totalUsd and current LTC prices
                const { ltcPriceUsd, ltcPriceEur } = await getLTCPrices();
                dashboardData.totalEur = dashboardData.totalUsd * (ltcPriceEur / ltcPriceUsd);

                await saveDashboardData(); // Save updated totalEur

                const dashboardEmbed = new EmbedBuilder()
                    .setColor(0x00ff00)
                    .setTitle('<:admin:1288864988030701601> Dashboard')
                    .addFields(
                        { name: '<:777:1288865238690693121> Total Deals Done', value: `${dashboardData.totalDeals}`, inline: true },
                        { name: '<a:tick:1288865432274600081> Succeeded Deals (Released)', value: `${dashboardData.succeededDeals}`, inline: true },
                        { name: '<:lia002:1288865358651986051> Refunded Deals', value: `${dashboardData.refundedDeals}`, inline: true },
                        { name: '<a:Snowy_Dollar:1261530962198659103> Total Worth (USD)', value: `$${dashboardData.totalUsd.toFixed(2)}`, inline: true },
                        { name: '<:pingers_euro:1288865825452720169> Total Worth (EUR)', value: `€${dashboardData.totalEur.toFixed(2)}`, inline: true },
                        { name: '<:LTC:1246374588338802739> Total LTC Value', value: `${dashboardData.totalLtc.toFixed(8)} LTC`, inline: true }
                    )
                    .setTimestamp()
                    .setFooter({ text: 'Auto MM Bot Dashboard', iconURL: client.user.displayAvatarURL() });

                await message.channel.send({ embeds: [dashboardEmbed] });
            } finally {
                release(); // Release the mutex
            }
        } catch (error) {
            console.error('Error generating dashboard:', error);
            await message.channel.send('<:cross_ds:1281651023768715389> An error occurred while generating the dashboard.');
        }
    }
});

client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isButton()) {
            const { customId, channel, user } = interaction;

            if (!channel || !channel.isTextBased()) return;

            if (customId === 'create_ticket') {
                // Create a modal to collect deal information
                const modal = new ModalBuilder()
                    .setCustomId('deal_modal')
                    .setTitle('Describe Your Deal');

                const dealInput = new TextInputBuilder()
                    .setCustomId('deal_description')
                    .setLabel('Please describe your deal in short')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true);

                const firstActionRow = new ActionRowBuilder().addComponents(dealInput);

                modal.addComponents(firstActionRow);

                await interaction.showModal(modal);
            } else {
                // Handle other button interactions
                await handleButtonInteraction(interaction);
            }
        } else if (interaction.isModalSubmit()) {
            if (interaction.customId === 'deal_modal') {
                // Defer the reply immediately
                await interaction.deferReply({ ephemeral: true });

                // Handle the modal submission
                const dealDescription = interaction.fields.getTextInputValue('deal_description');

                // Assign a unique deal number
                dealNumbers.lastDealNumber += 1;
                const dealNumber = dealNumbers.lastDealNumber;
                await fs.writeFile('dealNumbers.json', JSON.stringify(dealNumbers, null, 4));

                // Create the ticket channel
                const ticketChannel = await interaction.guild.channels.create({
                    name: `ticket-${dealNumber}`,
                    type: 0, // 0 is for text channels in discord.js v14
                    parent: TICKET_CATEGORY_ID,
                    permissionOverwrites: [
                        {
                            id: interaction.guild.id,
                            deny: [PermissionFlagsBits.ViewChannel],
                        },
                        {
                            id: interaction.user.id,
                            allow: [
                                PermissionFlagsBits.ViewChannel,
                                PermissionFlagsBits.SendMessages,
                                PermissionFlagsBits.ReadMessageHistory,
                            ],
                        },
                    ],
                });

                // Add the Close button to the welcome message
                const closeRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('close_ticket')
                        .setLabel('Close Ticket')
                        .setStyle(ButtonStyle.Danger)
                );

                // Send the welcome embed message including the deal description
                const welcomeEmbed = new EmbedBuilder()
                    .setColor(0x0099ff)
                    .setTitle(`Ticket Created - Deal #${dealNumber}`)
                    .setDescription(
                        `**Deal Description:**\n${dealDescription}\n\nWelcome to your ticket, ${interaction.user}.\n\n### Please provide the User ID of the participant you want to add to this ticket.`
                    );

                // Edit the deferred reply with the ticket information
                await interaction.editReply({ content: `Your ticket has been created: ${ticketChannel}` });

                await ticketChannel.send({ embeds: [welcomeEmbed], components: [closeRow] });

                // Store ticket data
                tickets.set(ticketChannel.id, {
                    ownerId: interaction.user.id,
                    channelId: ticketChannel.id,
                    participants: [interaction.user.id],
                    state: 'awaiting_user',
                    data: {
                        dealNumber: dealNumber,
                        dealDescription: dealDescription,
                        LTCMM: '',
                        value: 0,
                        roleConfirmedUsers: new Set(),
                        agreedUsers: new Set(),
                        amountConfirmedUsers: new Set(),
                        cancelConfirmedUsers: new Set(),
                    },
                });

                // Save tickets to file
                await saveTicketsToFile();

                // Prompt the user to provide a valid User ID
                await promptForUserId(ticketChannel, interaction.user);
            }
        }
    } catch (error) {
        console.error('An error occurred in interactionCreate handler:', error);
        // Check if the interaction has not been replied to or deferred
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            try {
                await interaction.reply({ content: 'An error occurred while processing your interaction.', ephemeral: true });
            } catch (err) {
                console.error('Failed to send error reply:', err);
            }
        }
    }
});


async function handleButtonInteraction(interaction) {
    try {
        const { customId, channel, user } = interaction;

        if (!channel || !channel.isTextBased()) return;

        const ticket = tickets.get(channel.id);

        // Handle copy buttons (these don't require a ticket)
        if (customId === 'copy_address' || customId === 'copy_amount') {
            await interaction.deferReply({ ephemeral: true });
            if (customId === 'copy_address') {
                if (ticket && ticket.data && ticket.data.ltcAddress) {
                    await interaction.editReply({ content: ticket.data.ltcAddress });
                } else {
                    await interaction.editReply({ content: 'LTC Address not available.' });
                }
            } else if (customId === 'copy_amount') {
                if (ticket && ticket.data && ticket.data.ltcAmount) {
                    await interaction.editReply({ content: ticket.data.ltcAmount.toFixed(8) });
                } else {
                    await interaction.editReply({ content: 'LTC Amount not available.' });
                }
            }
            return;
        }

        // If the ticket is not found, inform the user
        if (!ticket) {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'This ticket is no longer active.', ephemeral: true });
            }
            return;
        }

        // Check if the user is part of the ticket or an admin
        const isParticipant = ticket.participants.includes(user.id);
        const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);

        if (!isParticipant && !isAdmin) {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '<:cross_ds:1281651023768715389> You are not authorized to perform this action.', ephemeral: true });
            }
            return;
        }

        // Handle different custom IDs
        switch (customId) {
            case 'close_ticket':
                if (user.id !== ticket.ownerId && !isAdmin) {
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.reply({
                            content: 'Only the ticket owner or an admin can close this ticket.',
                            ephemeral: true,
                        });
                    }
                    return;
                }
                await interaction.deferUpdate();
                await closeTicket(channel, user);
                break;

            case 'delete_ticket':
                await interaction.deferReply({ ephemeral: true });
                await interaction.editReply({ content: 'Deleting the ticket...' });
                await channel.delete();
                tickets.delete(channel.id);
                await saveTicketsToFile();
                break;

            case 'transcript_ticket':
                await interaction.deferReply({ ephemeral: true });
                await sendTranscript(channel, ticket);
                await interaction.editReply({ content: 'Transcript has been saved.' });
                break;

            case 'open_ticket':
                await interaction.deferReply({ ephemeral: true });
                for (const participantId of ticket.participants) {
                    await channel.permissionOverwrites.edit(participantId, {
                        ViewChannel: true,
                        SendMessages: true,
                        ReadMessageHistory: true,
                    });
                }
                await interaction.editReply({ content: 'Ticket has been reopened.' });
                // Remove the closed message
                if (interaction.message && interaction.message.deletable) {
                    await interaction.message.delete();
                }
                break;

            case 'role_buyer':
            case 'role_seller':
            case 'reset_roles':
                await handleRoleSelection(interaction, ticket);
                break;

            case 'confirm_roles':
            case 'restart_role_selection':
                await handleRoleConfirmation(interaction, ticket);
                break;

            case 'agree_tos':
                await handleTosAgreement(interaction, ticket);
                break;

            case 'confirm_amount':
            case 'restart_amount':
                await handleAmountConfirmation(interaction, ticket);
                break;

            case 'release_funds':
            case 'cancel_transaction':
            case 'confirm_cancel':
                await handleTransactionDecision(interaction, ticket);
                break;

            case 'confirm_address':
            case 'confirm_buyer_address':
            case 'restart_address':
            case 'restart_buyer_address':
                await handleAddressConfirmation(interaction, ticket);
                break;

            case 'transcript_button':
                await handleTranscriptButton(interaction, ticket);
                break;

            default:
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: 'Unknown action.', ephemeral: true });
                }
                break;
        }
    } catch (error) {
        console.error('An error occurred in handleButtonInteraction:', error);
        if (!interaction.replied && !interaction.deferred) {
            try {
                await interaction.reply({ content: '<:cross_ds:1281651023768715389> An error occurred while processing your interaction.', ephemeral: true });
            } catch (err) {
                console.error('Failed to send error reply:', err);
            }
        }
    }
}


async function handleTranscriptButton(interaction, ticket) {
    try {
        // Defer the reply to prevent the interaction from timing out
        await interaction.deferReply({ ephemeral: true });

        const user = interaction.user;

        // Generate the transcript of the ticket channel
        const attachment = await createTranscript(interaction.channel);

        // Retrieve deal details
        const dealDetails = currentDeals[interaction.channel.id];
        if (!dealDetails) {
            console.error('Deal details not found.');
            await interaction.editReply({ content: '<:cross_ds:1281651023768715389> Error: Deal details not found.' });
            return;
        }

        // Prepare the deal information message, excluding sensitive data
        const dealInfo = `**Deal Number:** ${dealDetails['deal number']}
**Deal Description:** ${dealDetails['deal description']}
**Seller:** <@${dealDetails['seller id']}> (${dealDetails['seller id']})
**Buyer:** <@${dealDetails['buyer id']}> (${dealDetails['buyer id']})
**Amount:** $${(dealDetails['amount in usd'] || 0).toFixed(2)} USD
**Transaction ID:** ${dealDetails['transaction id'] || 'N/A'}
`;

        // Send the transcript and deal information to the user's DM
        await user.send({
            content: `📄 **Transcript for ticket ${interaction.channel.name}:**\n\n${dealInfo}`,
            files: [attachment],
        });

        // Inform the user that the transcript has been sent
        await interaction.editReply({ content: '<a:stick:1286929618250633371> Transcript has been sent to your DM.' });
    } catch (error) {
        console.error('Error in handleTranscriptButton:', error);

        // Handle the case where the bot cannot send a DM to the user
        if (error.code === 50007) { // Cannot send messages to this user
            await interaction.editReply({
                content: '<:cross_ds:1281651023768715389> Unable to send you a DM. Please check your privacy settings and try again.',
                ephemeral: true,
            });
        } else {
            await interaction.editReply({
                content: '<:cross_ds:1281651023768715389> An error occurred while sending the transcript.',
                ephemeral: true,
            });
        }
    }
}



async function promptForUserId(ticketChannel, ownerUser) {
    const filter = (msg) => msg.author.id === ownerUser.id;
    const collector = ticketChannel.createMessageCollector({ filter, time: 1800000 }); // 30 minutes timeout

    collector.on('collect', async (msg) => {
        try {
            const userId = msg.content.trim();
            const userToAddMember = await ticketChannel.guild.members.fetch(userId);
            const userToAdd = userToAddMember.user;
            if (userToAdd) {
                await ticketChannel.permissionOverwrites.create(userToAddMember, {
                    ViewChannel: true,
                    SendMessages: true,
                    ReadMessageHistory: true,
                });
                await ticketChannel.send(`${userToAdd} has been added to this ticket.`);

                // Update ticket data
                const ticket = tickets.get(ticketChannel.id);
                ticket.participants.push(userToAdd.id);
                ticket.state = 'role_selection';
                ticket.data.userToAdd = userToAdd;

                // Proceed to role selection
                await startRoleSelection(ticketChannel, ownerUser, userToAdd);
                collector.stop('user_added');
                await saveTicketsToFile();
            } else {
                await ticketChannel.send('User not found. Please ensure you have entered a valid User ID.');
            }
        } catch (error) {
            console.error('Error adding user to ticket:', error.message);
            await ticketChannel.send('User not found or an error occurred. Please ensure you have entered a valid User ID.');
        }
    });

    collector.on('end', async (collected, reason) => {
        if (reason !== 'user_added') {
            await ticketChannel.send('Time expired. Please reopen the ticket to add a participant.');
        }
    });
}

async function closeTicket(ticketChannel, closer) {
    const ticket = tickets.get(ticketChannel.id);
    if (!ticket) return;

    // Remove permissions for participants
    for (const participantId of ticket.participants) {
        try {
            // Attempt to fetch the user; if not found, assume it's a role
            const member = await ticketChannel.guild.members.fetch(participantId).catch(() => null);
            if (member) {
                // It's a user
                await ticketChannel.permissionOverwrites.edit(participantId, { ViewChannel: false });
            } else {
                // It's a role
                const role = ticketChannel.guild.roles.cache.get(participantId);
                if (role) {
                    await ticketChannel.permissionOverwrites.edit(participantId, { ViewChannel: false });
                } else {
                    console.warn(`Invalid participant ID: ${participantId}. Skipping permission edit.`);
                }
            }
        } catch (error) {
            console.error(`Failed to edit permissions for ${participantId}:`, error);
            // Optionally notify in the channel
            await ticketChannel.send(`<:cross_ds:1281651023768715389> Failed to update permissions for <@${participantId}>.`);
        }
    }

    // Send the ticket closed message with options
    const closedEmbed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle('Ticket Closed')
        .setDescription('This ticket has been closed. Choose an option below:');

    const closedRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('delete_ticket')
            .setLabel('Delete')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId('transcript_ticket')
            .setLabel('Transcript')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('open_ticket')
            .setLabel('Open')
            .setStyle(ButtonStyle.Success)
    );

    await ticketChannel.send({ embeds: [closedEmbed], components: [closedRow] });

    ticket.state = 'closed';
    await saveTicketsToFile();
    ticketMutexes.delete(ticket.channelId);
}


async function startRoleSelection(ticketChannel, user1, user2) {
    // Initialize role data
    const ticket = tickets.get(ticketChannel.id);
    ticket.state = 'role_selection';
    ticket.data.roles = {};
    ticket.data.roleConfirmedUsers = new Set();

    // Create the embed with buyer and seller fields
    const roleEmbed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setTitle('Select Your Role')
        .setDescription('Please select your role by clicking one of the buttons below.')
        .addFields(
            { name: 'Buyer', value: '`-`', inline: true },
            { name: 'Seller', value: '`-`', inline: true }
        );

    // Create the buttons
    const roleRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('role_buyer')
            .setLabel('Buyer')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('role_seller')
            .setLabel('Seller')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('reset_roles')
            .setLabel('Reset')
            .setStyle(ButtonStyle.Secondary)
    );

    const roleMessage = await ticketChannel.send({
        content: `${user1} and ${user2}, please select your roles:`,
        embeds: [roleEmbed],
        components: [roleRow],
    });

    ticket.data.roleMessageId = roleMessage.id; // Store the message ID
    await saveTicketsToFile();
}

async function updateRoleEmbed(channel, ticket) {
    // Fetch the role message
    const roleMessage = await channel.messages.fetch(ticket.data.roleMessageId);
    if (!roleMessage) return;

    // Update the embed
    const buyerField = { name: 'Buyer', value: '`-`', inline: true };
    const sellerField = { name: 'Seller', value: '`-`', inline: true };

    for (const [userId, role] of Object.entries(ticket.data.roles)) {
        if (role === 'buyer') {
            buyerField.value = `<@${userId}>`;
        } else if (role === 'seller') {
            sellerField.value = `<@${userId}>`;
        }
    }

    const updatedEmbed = EmbedBuilder.from(roleMessage.embeds[0])
        .setFields(buyerField, sellerField);

    await roleMessage.edit({ embeds: [updatedEmbed] });
}

async function handleRoleSelection(interaction, ticket) {
    const { customId, user } = interaction;

    // Defer the reply immediately
    await interaction.deferReply({ ephemeral: true });

    // Initialize mutex for the ticket
    if (!ticketMutexes.has(ticket.channelId)) {
        ticketMutexes.set(ticket.channelId, new Mutex());
    }
    const mutex = ticketMutexes.get(ticket.channelId);

    const release = await mutex.acquire();
    try {
        if (customId === 'reset_roles') {
            // Reset roles
            ticket.data.roles = {};
            await updateRoleEmbed(interaction.channel, ticket);

            await interaction.editReply({ content: '<a:stick:1286929618250633371> Roles have been reset.' });
            return;
        }

        const role = customId === 'role_buyer' ? 'buyer' : 'seller';

        // Check if the role is already taken
        if (Object.values(ticket.data.roles).includes(role)) {
            await interaction.editReply({ content: `<:cross_ds:1281651023768715389> The role of ${role} has already been taken.` });
            return;
        }

        // Assign the role to the user
        ticket.data.roles[user.id] = role;
        await updateRoleEmbed(interaction.channel, ticket);

        await interaction.editReply({
            content: `<a:stick:1286929618250633371> You have selected **${role.charAt(0).toUpperCase() + role.slice(1)}** as your role.`,
        });

        if (Object.keys(ticket.data.roles).length === 2) {
            // Proceed to role confirmation
            const buyerId = Object.keys(ticket.data.roles).find(id => ticket.data.roles[id] === 'buyer');
            const sellerId = Object.keys(ticket.data.roles).find(id => ticket.data.roles[id] === 'seller');
        
            const confirmEmbed = new EmbedBuilder()
                .setColor(0x0099ff)
                .setTitle('Confirm Roles')
                .setDescription(
                    `Please confirm the selected roles:\n\n` +
                    `**Buyer:** <@${buyerId}>\n` +
                    `**Seller:** <@${sellerId}>`
                );
        
            const confirmRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('confirm_roles')
                    .setLabel('Confirm')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('restart_role_selection')
                    .setLabel('Restart')
                    .setStyle(ButtonStyle.Danger)
            );
        
            const confirmMessage = await interaction.channel.send({ embeds: [confirmEmbed], components: [confirmRow] });
        ticket.data.roleConfirmMessageId = confirmMessage.id; // Store the message ID
        await saveTicketsToFile();

        // Delete the "Select Your Role" message
        if (ticket.data.roleMessageId) {
            try {
                const roleMessage = await interaction.channel.messages.fetch(ticket.data.roleMessageId);
                if (roleMessage) {
                    await roleMessage.delete();
                }
            } catch (error) {
                console.error('Error deleting role selection message:', error);
            }
        }
    }
    } finally {
        release(); // Release the mutex lock
    }
}



async function handleRoleConfirmation(interaction, ticket) {
    const { customId, user } = interaction;

    // Defer the interaction immediately
    await interaction.deferReply({ ephemeral: true });

    try {
        if (customId === 'confirm_roles') {
            // Check if the user has already confirmed
            if (ticket.data.roleConfirmedUsers.has(user.id)) {
                await interaction.editReply({ content: 'You have already confirmed the roles.' });
                return;
            }

            ticket.data.roleConfirmedUsers.add(user.id);
            await interaction.editReply({ content: '<a:stick:1286929618250633371> You have confirmed the roles.' });

            // Check if both users have confirmed and if we haven't proceeded yet
            if (ticket.data.roleConfirmedUsers.size === 2 && !ticket.data.rolesConfirmed) {
                ticket.data.rolesConfirmed = true; // Set a flag to prevent duplicates

                await interaction.channel.send('<a:stick:1286929618250633371> Both parties have confirmed the roles. Proceeding to Terms of Service.');

                // Disable the confirm and restart buttons
                await disableRoleConfirmationButtons(interaction.channel, ticket);

                // Proceed to Terms of Service agreement
                const ticketId = ticket.channelId;
                const buyerId = Object.keys(ticket.data.roles).find(id => ticket.data.roles[id] === 'buyer');
                const sellerId = Object.keys(ticket.data.roles).find(id => ticket.data.roles[id] === 'seller');

                if (!buyerId || !sellerId) {
                    console.error('Buyer or Seller ID is missing.');
                    await interaction.channel.send('<:cross_ds:1281651023768715389> An error occurred: Buyer or Seller role not assigned correctly.');
                    return;
                }

                currentDeals[ticketId] = {
                    'deal number': ticket.data.dealNumber,
                    'deal description': ticket.data.dealDescription,
                    'addy of seller': '',
                    'owner ID': ticket.ownerId,
                    'amount in usd': 0,
                    'seller id': sellerId,
                    'buyer id': buyerId,
                    'LTCMM': '',
                    'value': 0,
                    'mnemonic': '',
                    'private key': '',
                };

                // Save currentDeals to current.json
                await fs.writeFile('current.json', JSON.stringify(currentDeals, null, 4));

                await termsOfServiceAgreement(interaction.channel, ticket);
                await saveTicketsToFile();
            }
        } else if (customId === 'restart_role_selection') {
            // Reset flags and data
            ticket.data.roles = {};
            ticket.data.roleConfirmedUsers = new Set();
            ticket.data.rolesConfirmed = false;

            await interaction.editReply({ content: '🔄 Role selection has been restarted.' });

            // Disable the confirm and restart buttons
            await disableRoleConfirmationButtons(interaction.channel, ticket);

            // Restart role selection
            const [user1Id, user2Id] = ticket.participants;
            const user1 = await interaction.guild.members.fetch(user1Id);
            const user2 = await interaction.guild.members.fetch(user2Id);
            await startRoleSelection(interaction.channel, user1.user, user2.user);
        } else {
            await interaction.editReply({ content: '<:cross_ds:1281651023768715389> Invalid action.' });
        }
    } catch (error) {
        console.error('Error in handleRoleConfirmation:', error);
        if (interaction.deferred) {
            await interaction.editReply({ content: '<:cross_ds:1281651023768715389> An error occurred while processing your interaction.' });
        }
    }
}





async function disableRoleConfirmationButtons(channel, ticket) {
    try {
        const confirmMessage = await channel.messages.fetch(ticket.data.roleConfirmMessageId);
        if (confirmMessage) {
            const disabledRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('confirm_roles')
                    .setLabel('Confirm')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId('restart_role_selection')
                    .setLabel('Restart')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(true)
            );
            await confirmMessage.edit({ components: [disabledRow] });
        }
    } catch (error) {
        console.error('Error disabling role confirmation buttons:', error);
    }
}


async function disableConfirmButtonForUser(interaction, ticket) {
    try {
        // Acknowledge the interaction immediately
        // Fetch the message
        const confirmMessage = await interaction.channel.messages.fetch(ticket.data.roleConfirmMessageId);

        if (confirmMessage) {
            // Modify the components to disable the confirm button for the user
            const components = confirmMessage.components.map((actionRow) => {
                const updatedComponents = actionRow.components.map((button) => {
                    if (button.customId === 'confirm_roles') {
                        return ButtonBuilder.from(button).setDisabled(true);
                    }
                    return button;
                });
                return new ActionRowBuilder().addComponents(updatedComponents);
            });

            await confirmMessage.edit({ components });
        }
    } catch (error) {
        console.error('Error disabling confirm button for user:', error);
    }
}


async function termsOfServiceAgreement(channel, ticket) {
    const tosEmbed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setTitle('__Terms of Service Agreement__')
        .setDescription('**Please both discuss Terms of Service.\nThis is the most important part of the deal.\nAfter discussing, please click the Agree button.**');

    const tosRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('agree_tos')
            .setLabel('Agree')
            .setStyle(ButtonStyle.Primary)
    );

    const tosMessage = await channel.send({
        content: `<@${ticket.ownerId}> and <@${ticket.data.userToAdd.id}>, please agree to the Terms of Service by clicking the button below.`,
        embeds: [tosEmbed],
        components: [tosRow],
    });
    ticket.data.tosMessageId = tosMessage.id; // Store the message ID

    ticket.state = 'tos_agreement';
    ticket.data.agreedUsers = new Set();
    await saveTicketsToFile();
}

async function handleTosAgreement(interaction, ticket) {
    const { user } = interaction;

    // Initialize the mutex for this ticket if not already done
    if (!ticketMutexes.has(ticket.channelId)) {
        ticketMutexes.set(ticket.channelId, new Mutex());
    }
    const mutex = ticketMutexes.get(ticket.channelId);

    const release = await mutex.acquire();
    try {
        ticket.data.agreedUsers.add(user.id);
        await interaction.reply({ content: '<a:stick:1286929618250633371> You have agreed to the Terms of Service.', ephemeral: true });

        // Check if both users have agreed and if we haven't proceeded yet
        if (ticket.data.agreedUsers.size === 2 && !ticket.data.tosAgreed) {
            ticket.data.tosAgreed = true; // Set a flag to prevent duplicates

            await interaction.channel.send('<a:stick:1286929618250633371> Both parties have agreed to the Terms of Service.');

            // Disable the TOS agree button
            await disableTosAgreeButton(interaction.channel, ticket);

            // Proceed to transaction amount entry
            await enterTransactionAmount(interaction.channel, ticket);
            await saveTicketsToFile();
        }
    } catch (error) {
        console.error('Error in handleTosAgreement:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '<:cross_ds:1281651023768715389> An error occurred while processing your interaction.', ephemeral: true });
        }
    } finally {
        release();
    }
}

async function disableTosAgreeButton(channel, ticket) {
    try {
        const tosMessage = await channel.messages.fetch(ticket.data.tosMessageId);
        if (tosMessage) {
            const disabledRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('agree_tos')
                    .setLabel('Agree')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(true)
            );
            await tosMessage.edit({ components: [disabledRow] });
        }
    } catch (error) {
        console.error('Error disabling TOS agree button:', error);
    }
}



async function enterTransactionAmount(channel, ticket) {
    try {
        let buyerId = currentDeals[channel.id]['buyer id'];

        // If buyerId is a mention, extract the raw ID
        if (buyerId.startsWith('<@') && buyerId.endsWith('>')) {
            buyerId = buyerId.replace(/[<@!>]/g, '');
        }

        if (!buyerId) {
            await channel.send('❌ Buyer ID not found. Please check the current deals.');
            return;
        }

        await channel.send(`<@${buyerId}>, please enter the transaction amount in USD. [$]`);

        const priceFilter = (m) => m.author.id === buyerId && m.channel.id === channel.id;

        const priceCollector = channel.createMessageCollector({ filter: priceFilter, time: 1800000 }); // 30 minutes timeout

        priceCollector.on('collect', async (message) => {
            try {
                const input = message.content.trim();

                // Validate that the entire input is a number (integer or decimal)
                if (!/^\d+(\.\d+)?$/.test(input)) {
                    await channel.send('<:cross_ds:1281651023768715389> Invalid input. Please enter a valid number in USD.');
                    return;
                }

                const amountUsd = Number(input);

                // Check if the input is a valid number and greater than 0
                if (isNaN(amountUsd) || amountUsd <= 0) {
                    await channel.send('<:cross_ds:1281651023768715389> Invalid input. Please enter a number greater than 0 in USD.');
                    return;
                }

                // Stop the collector once a valid number is provided
                priceCollector.stop('valid_number');

                // Proceed to confirmation
                const amountEmbed = new EmbedBuilder()
                    .setColor(0x0099ff)
                    .setTitle('Confirm Transaction Amount')
                    .setDescription(
                        `The transaction amount is set to **$${amountUsd.toFixed(2)} USD**.\n\nPlease confirm or restart.`
                    );

                const amountRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('confirm_amount')
                        .setLabel('Confirm')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('restart_amount')
                        .setLabel('Restart')
                        .setStyle(ButtonStyle.Danger)
                );

                const amountMessage = await channel.send({ embeds: [amountEmbed], components: [amountRow] });

                ticket.data.amountConfirmMessageId = amountMessage.id; // Store the message ID

                // Initialize amountConfirmedUsers as an Array
                ticket.data.amountConfirmedUsers = [];

                // Store amount in ticket data
                ticket.data.amountUsd = amountUsd;
                ticket.state = 'amount_confirmation';

                await saveTicketsToFile();
            } catch (collectError) {
                console.error('Error in priceCollector collect handler:', collectError);
                await channel.send('⚠️ An unexpected error occurred. Please try again.');
                priceCollector.stop('error');
            }
        });

        priceCollector.on('end', (collected, reason) => {
            if (reason !== 'valid_number') {
                channel.send('⏰ Time expired. Please reopen the ticket to enter the transaction amount.');
            }
        });
    } catch (error) {
        console.error('Error in enterTransactionAmount:', error);
        await channel.send('⚠️ An unexpected error occurred while processing your request. Please try again later.');
    }
}

async function handleAmountConfirmation(interaction, ticket) {
    const { customId, user } = interaction;

    // Initialize the mutex for this ticket if not already done
    if (!ticketMutexes.has(ticket.channelId)) {
        ticketMutexes.set(ticket.channelId, new Mutex());
    }
    const mutex = ticketMutexes.get(ticket.channelId);

    const release = await mutex.acquire();
    try {
        if (customId === 'confirm_amount') {
            // Ensure amountConfirmedUsers is an Array
            if (!Array.isArray(ticket.data.amountConfirmedUsers)) {
                ticket.data.amountConfirmedUsers = [];
            }

            // Prevent duplicate confirmations
            if (!ticket.data.amountConfirmedUsers.includes(user.id)) {
                ticket.data.amountConfirmedUsers.push(user.id);
                await interaction.reply({ content: '<a:stick:1286929618250633371> You have confirmed the transaction amount.', ephemeral: true });
            } else {
                await interaction.reply({ content: '✅ You have already confirmed the transaction amount.', ephemeral: true });
            }

            // Check if both parties have confirmed
            if (ticket.data.amountConfirmedUsers.length === 2 && !ticket.data.amountConfirmed) {
                ticket.data.amountConfirmed = true;

                await interaction.channel.send('<a:stick:1286929618250633371> Both parties have confirmed the transaction amount.');

                // Disable the confirm and restart buttons
                await disableAmountConfirmationButtons(interaction.channel, ticket);

                // Proceed to the next step
                await sendPaymentInstructions(interaction.channel, ticket);
                await saveTicketsToFile();
            }
        } else if (customId === 'restart_amount') {
            // Disable the confirm and restart buttons
            await disableAmountConfirmationButtons(interaction.channel, ticket);

            await interaction.reply({ content: '🔄 Restarting transaction amount entry.', ephemeral: true });

            // Reset confirmation data
            ticket.data.amountConfirmedUsers = []; // Initialize as an empty array
            ticket.data.amountConfirmed = false;

            await enterTransactionAmount(interaction.channel, ticket);
            await saveTicketsToFile();
        } else {
            await interaction.reply({ content: '<:cross_ds:1281651023768715389> Invalid action.', ephemeral: true });
        }
    } catch (error) {
        console.error('Error in handleAmountConfirmation:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '<:cross_ds:1281651023768715389> An error occurred while processing your interaction.', ephemeral: true });
        }
    } finally {
        release();
    }
}


async function disableAmountConfirmationButtons(channel, ticket) {
    try {
        const amountMessage = await channel.messages.fetch(ticket.data.amountConfirmMessageId);
        if (amountMessage) {
            const disabledRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('confirm_amount')
                    .setLabel('Confirm')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId('restart_amount')
                    .setLabel('Restart')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(true)
            );
            await amountMessage.edit({ components: [disabledRow] });
        }
    } catch (error) {
        console.error('Error disabling amount confirmation buttons:', error);
    }
}



async function sendPaymentInstructions(channel, ticket) {
    // Generate a new LTC wallet for this deal using bip39 and bitcoinjs-lib with Litecoin parameters
    const mnemonic = bip39.generateMnemonic();
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const root = bitcoin.bip32.fromSeed(seed, litecoinNetwork);

    // Derive the address using Litecoin's derivation path m/44'/2'/0'/0/0
    const child = root.derivePath("m/44'/2'/0'/0/0");
    const { address } = bitcoin.payments.p2pkh({
        pubkey: child.publicKey,
        network: litecoinNetwork,
    });

    // Store private key and mnemonic securely
    ticket.data.ltcPrivateKey = child.toWIF();
    ticket.data.ltcAddress = address;
    ticket.data.mnemonic = mnemonic;

    // Save to current.json
    currentDeals[channel.id]['mnemonic'] = ticket.data.mnemonic;
    currentDeals[channel.id]['private key'] = ticket.data.ltcPrivateKey;
    currentDeals[channel.id]['LTCMM'] = address;
    currentDeals[channel.id]['value'] = 0;
    await fs.writeFile('current.json', JSON.stringify(currentDeals, null, 4));

    // Fetch current LTC prices
    const amountUsd = ticket.data.amountUsd;
    let ltcPriceUsd, ltcPriceEur, ltcAmount, amountEur;

    try {
        const { ltcPriceUsd, ltcPriceEur } = await getLTCPrices();

        // Calculate the LTC amount equivalent to the USD amount
        ltcAmount = amountUsd / ltcPriceUsd;
        amountEur = amountUsd * (ltcPriceEur / ltcPriceUsd);
        ticket.data.ltcAmount = ltcAmount;

        // Update currentDeals with LTC amount
        currentDeals[channel.id]['value'] = ltcAmount;
        currentDeals[channel.id]['amount in usd'] = amountUsd;
        await fs.writeFile('current.json', JSON.stringify(currentDeals, null, 4));

        // Send payment instructions to the buyer
        const buyerId = currentDeals[channel.id]['buyer id'];
        const paymentEmbed = new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle('Payment Instructions')
            .setDescription(
                `**Please send the payment to the following LTC address:**\n\n` +
                    `\`\`\`\n${address}\n\`\`\`\n` +
                    `**Amount to send:**\n\n` +
                    `\`\`\`\n${ltcAmount.toFixed(8)} LTC\n\`\`\`\n` +
                    `**Equivalent to:**\n` +
                    `$${amountUsd.toFixed(2)} USD\n` +
                    `€${amountEur.toFixed(2)} EUR\n\n` +
                    `**Current LTC Price:**\n` +
                    `$${ltcPriceUsd.toFixed(2)} USD\n` +
                    `€${ltcPriceEur.toFixed(2)} EUR`
            );

        // Copy buttons for mobile users
        const copyRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('copy_address')
                .setLabel('Copy Address')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('copy_amount')
                .setLabel('Copy Amount')
                .setStyle(ButtonStyle.Secondary)
        );

        await channel.send({ content: `<@${buyerId}>`, embeds: [paymentEmbed], components: [copyRow] });

        // Wait for the buyer to send the payment
        await monitorIncomingTransaction(channel, ticket);
    } catch (error) {
        console.error('Error fetching LTC prices:', error);
        await channel.send('An error occurred while fetching LTC prices. Please try again later.');
    }
}

// Import Bottleneck at the top of your file
const Bottleneck = require('bottleneck');

// Create a limiter instance
const limiter = new Bottleneck({
    minTime: 1000, // Minimum time between requests (1 second)
    maxConcurrent: 1 // Only one request at a time
});

// Replace axios with a rate-limited version
const axiosInstance = axios.create();

axiosInstance.interceptors.request.use(async (config) => {
    await limiter.schedule(() => Promise.resolve());
    return config;
});

async function monitorIncomingTransaction(channel, ticket) {
    const address = ticket.data.ltcAddress;
    const requiredAmount = parseFloat(ticket.data.ltcAmount.toFixed(8));
    const dealId = channel.id;

    let attempts = 0;
    const maxAttempts = 120; // 120 attempts x 30 seconds = 60 minutes
    const initialCheckInterval = 30000; // 30 seconds in milliseconds
    let checkInterval = initialCheckInterval;

    // Store the last known transaction ID to prevent duplicate processing
    let lastTxId = currentDeals[channel.id]['transaction id'] || null;

    const checkTransaction = async () => {
        try {
            if (!BLOCKCYPHER_TOKEN) {
                console.error('BlockCypher token is not set.');
                await channel.send('<:cross_ds:1281651023768715389> **Error:** BlockCypher token is not set. Please contact the administrator.');
                return;
            }

            // Fetch transaction information using BlockCypher API with rate limiting
            const response = await axiosInstance.get(
                `https://api.blockcypher.com/v1/ltc/main/addrs/${address}/full?token=${BLOCKCYPHER_TOKEN}`
            );

            // Reset checkInterval back to initial value after a successful request
            checkInterval = initialCheckInterval;

            const transactions = response.data.txs || [];
            let newIncomingTx = null;

            // Iterate through transactions to find new incoming ones
            for (const tx of transactions) {
                // Check if the transaction is incoming to the monitored address
                const isIncoming = tx.outputs.some(output => output.addresses && output.addresses.includes(address));

                if (isIncoming) {
                    // If txId is already recorded, skip
                    if (tx.hash === lastTxId) {
                        continue;
                    }

                    newIncomingTx = tx;
                    break;
                }
            }

            if (newIncomingTx) {
                const txId = newIncomingTx.hash;
                const confirmations = newIncomingTx.confirmations;
                const incomingAmount = parseFloat(newIncomingTx.outputs
                    .filter(output => output.addresses && output.addresses.includes(address))
                    .reduce((sum, output) => sum + (output.value / 1e8), 0).toFixed(8)); // Convert satoshis to LTC

                console.log(`Deal ${dealId}: Detected incoming transaction.`);
                console.log(`Deal ${dealId}: Transaction ID: ${txId}`);
                console.log(`Deal ${dealId}: Incoming Amount: ${incomingAmount} LTC`);
                console.log(`Deal ${dealId}: Confirmations: ${confirmations}`);

                if (incomingAmount >= requiredAmount) {
                    // Update the lastTxId to prevent reprocessing
                    currentDeals[channel.id]['transaction id'] = txId;
                    await fs.writeFile('current.json', JSON.stringify(currentDeals, null, 4));

                    // Fetch current LTC prices
                    const { ltcPriceUsd, ltcPriceEur } = await getLTCPrices();
                    const amountUsd = (incomingAmount * ltcPriceUsd).toFixed(2);
                    const amountEur = (incomingAmount * ltcPriceEur).toFixed(2);

                    if (confirmations >= 1) { // Adjust the number of required confirmations as needed
                        const confirmedEmbed = new EmbedBuilder()
                            .setColor(0x00FF00)
                            .setTitle('<a:1792loading:1281651652553605120> Payment Incoming!')
                            .addFields(
                                { name: '<:LTC:1246374588338802739> Amount Receiving', value: `**${incomingAmount} LTC**`, inline: true },
                                { name: '<:2012usd:1277580536713449574> Equivalent', value: `$${amountUsd} USD / €${amountEur} EUR`, inline: true },
                                { name: '<a:7492symbollattice:1277580845900628021> Transaction ID', value: `\`${txId}\``, inline: false }
                            )
                            .setTimestamp();

                        await channel.send({ embeds: [confirmedEmbed] });

                        // Proceed to release options
                        await offerReleaseOptions(channel, ticket);
                    } else {
                        const awaitingEmbed = new EmbedBuilder()
                            .setColor(0xFFFF00)
                            .setTitle('<a:1792loading:1281651652553605120> Payment Incoming!')
                            .addFields(
                                { name: '<:LTC:1246374588338802739> Amount Incoming', value: `**${incomingAmount} LTC**`, inline: true },
                                { name: '<:2012usd:1277580536713449574> Equivalent', value: `$${amountUsd} USD / €${amountEur} EUR`, inline: true },
                                { name: '<a:7492symbollattice:1277580845900628021> Transaction ID', value: `\`${txId}\``, inline: false }
                            )
                            .setDescription('Awaiting transaction confirmation.')
                            .setTimestamp();

                        await channel.send({ embeds: [awaitingEmbed] });

                        // Start monitoring for confirmation
                        monitorTransactionConfirmation(channel, ticket, txId, incomingAmount, ltcPriceUsd, ltcPriceEur);
                    }
                } else {
                    console.log(`Deal ${dealId}: Incoming amount (${incomingAmount} LTC) is less than required (${requiredAmount} LTC).`);
                    // Continue monitoring without sending partial payment message
                }
            } else {
                attempts++;
                console.log(`Deal ${dealId}: Attempt ${attempts}/${maxAttempts}: Payment not yet received.`);
                if (attempts < maxAttempts) {
                    // Schedule the next check
                    setTimeout(checkTransaction, checkInterval);
                } else {
                    await channel.send('⏰ **Timeout:** Payment was not received within the expected timeframe.');
                }
            }
        } catch (error) {
            if (error.response && error.response.status === 404) {
                console.error('BlockCypher address not found:', error);
                await channel.send('<:cross_ds:1281651023768715389> **Error:** Address not found. Please contact support.');
                return;
            } else if (error.response && error.response.status === 429) {
                console.error('Rate limit exceeded when checking transaction. Retrying after delay.');
                // Exponential backoff
                checkInterval *= 2; // Double the interval
                if (checkInterval > 3600000) { // Cap at 1 hour
                    checkInterval = 3600000;
                }
            } else {
                console.error('Error checking transaction:', error);
            }

            await channel.send('⚠️ **Warning:** An error occurred while checking for transactions. Retrying...');
            if (attempts < maxAttempts) {
                attempts++;
                setTimeout(checkTransaction, checkInterval);
            } else {
                await channel.send('⏰ **Timeout:** Payment was not received within the expected timeframe.');
            }
        }
    };

    // Function to monitor transaction confirmations
    const monitorTransactionConfirmation = async (channel, ticket, txId, amount, ltcPriceUsd, ltcPriceEur) => {
        let confirmationAttempts = 0;
        const maxConfirmationAttempts = 60; // 60 attempts x 30 seconds = 30 minutes
        const initialConfirmationCheckInterval = 30000; // 30 seconds
        let confirmationCheckInterval = initialConfirmationCheckInterval;

        const checkConfirmation = async () => {
            try {
                // Fetch transaction confirmation status using rate-limited axios
                const response = await axiosInstance.get(
                    `https://api.blockcypher.com/v1/ltc/main/txs/${txId}?token=${BLOCKCYPHER_TOKEN}`
                );

                // Reset confirmationCheckInterval back to initial value after successful request
                confirmationCheckInterval = initialConfirmationCheckInterval;

                const confirmations = response.data.confirmations;

                console.log(`Deal ${channel.id}: Transaction ${txId} has ${confirmations} confirmations.`);

                if (confirmations >= 1) { // Adjust as needed
                    const confirmedEmbed = new EmbedBuilder()
                        .setColor(0x00FF00)
                        .setTitle('<a:vulkane:1282374309926404211> Payment Confirmed!')
                        .addFields(
                            { name: '<:LTC:1246374588338802739> Amount Received', value: `**${amount} LTC**`, inline: true },
                            { name: '<:2012usd:1277580536713449574> Equivalent', value: `$${(amount * ltcPriceUsd).toFixed(2)} USD / €${(amount * ltcPriceEur).toFixed(2)} EUR`, inline: true },
                            { name: '<a:7492symbollattice:1277580845900628021> Transaction ID', value: `\`${txId}\``, inline: false }
                        )
                        .setTimestamp();

                    await channel.send({ embeds: [confirmedEmbed] });

                    // Proceed to release options
                    await offerReleaseOptions(channel, ticket);
                } else {
                    confirmationAttempts++;
                    console.log(`Deal ${channel.id}: Attempt ${confirmationAttempts}/${maxConfirmationAttempts}: Transaction not yet confirmed.`);
                    if (confirmationAttempts < maxConfirmationAttempts) {
                        // Schedule the next confirmation check
                        setTimeout(checkConfirmation, confirmationCheckInterval);
                    } else {
                        await channel.send('⏰ **Timeout:** Payment confirmation was not received within the expected timeframe.');
                    }
                }
            } catch (error) {
                if (error.response && error.response.status === 429) {
                    console.error('Rate limit exceeded when checking transaction confirmation. Retrying after delay.');
                    // Exponential backoff
                    confirmationCheckInterval *= 2; // Double the interval
                    if (confirmationCheckInterval > 3600000) { // Cap at 1 hour
                        confirmationCheckInterval = 3600000;
                    }
                } else {
                    console.error('Error checking transaction confirmation:', error);
                }
                await channel.send('⚠️ **Warning:** An error occurred while checking transaction confirmation. Retrying...');
                if (confirmationAttempts < maxConfirmationAttempts) {
                    confirmationAttempts++;
                    setTimeout(checkConfirmation, confirmationCheckInterval);
                } else {
                    await channel.send('⏰ **Timeout:** Payment confirmation was not received within the expected timeframe.');
                }
            }
        };

        // Start monitoring for confirmation
        setTimeout(checkConfirmation, confirmationCheckInterval);
    };

    // Start the initial transaction check
    const initialEmbed = new EmbedBuilder()
        .setColor(0x0000FF)
        .setTitle('<a:4215symbolthreedot:1277580757765718047> Monitoring Payment')
        .setDescription('Awaiting your payment. This process may take a few minutes.')
        .setTimestamp();

    await channel.send({ embeds: [initialEmbed] });
    checkTransaction();
}


async function offerReleaseOptions(channel, ticket) {
    const buyerId = currentDeals[channel.id]['buyer id'];

    const releaseEmbed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setTitle('Funds Received and Confirmed')
        .setDescription('Please choose an option below.');

    const releaseRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('release_funds')
            .setLabel('Release')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('cancel_transaction')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Danger)
    );

    const releaseMessage = await channel.send({ content: `<@${buyerId}>`, embeds: [releaseEmbed], components: [releaseRow] });

    // Store the message ID to disable buttons later
    ticket.data.releaseMessageId = releaseMessage.id;

    ticket.state = 'awaiting_release';
    await saveTicketsToFile();
}

async function handleTransactionDecision(interaction, ticket) {
    const { customId, user, channel } = interaction;
    const buyerId = currentDeals[channel.id]['buyer id'];
    const sellerId = currentDeals[channel.id]['seller id'];

    // Function to disable the buttons
    const disableReleaseCancelButtons = async () => {
        const releaseMessage = await channel.messages.fetch(ticket.data.releaseMessageId);
        if (releaseMessage) {
            const disabledRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('release_funds')
                    .setLabel('Release')
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId('cancel_transaction')
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(true)
            );
            await releaseMessage.edit({ components: [disabledRow] });
        }
    };

    // Handle releasing funds
    if (customId === 'release_funds') {
        if (user.id !== buyerId) {
            await interaction.reply({ content: '<:cross_ds:1281651023768715389> Only the buyer can perform this action.', ephemeral: true });
            return;
        }

        await interaction.reply({ content: 'You have chosen to release the funds.', ephemeral: true });
        await channel.send('Funds will be released to the seller.');

        // Disable the "Release" and "Cancel" buttons
        await disableReleaseCancelButtons();

        // Proceed to collect seller's LTC address
        await requestSellerAddress(channel, ticket);
        await saveTicketsToFile();
    }

    // Handle cancellation (refund request)
    else if (customId === 'cancel_transaction') {
        if (user.id !== buyerId) {
            await interaction.reply({ content: '<:cross_ds:1281651023768715389> Only the buyer can initiate cancellation.', ephemeral: true });
            return;
        }

        await interaction.reply({ content: 'You have initiated a cancellation request.', ephemeral: true });
        await channel.send('Cancellation process initiated.');

        // Disable the "Release" and "Cancel" buttons
        await disableReleaseCancelButtons();

        // Ask both parties to confirm cancellation
        const cancelEmbed = new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle('Cancellation Request')
            .setDescription('Both parties need to confirm to cancel the transaction.');

        const cancelRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('confirm_cancel')
                .setLabel('Confirm Cancellation')
                .setStyle(ButtonStyle.Danger)
        );

        const cancelMessage = await channel.send({
            content: `<@${buyerId}> and <@${sellerId}>`,
            embeds: [cancelEmbed],
            components: [cancelRow],
        });

        ticket.data.cancelConfirmMessageId = cancelMessage.id;
        ticket.data.cancelConfirmedUsers = new Set();
        await saveTicketsToFile();
    }

    // Confirm cancellation by both parties
    else if (customId === 'confirm_cancel') {
        if (![buyerId, sellerId].includes(user.id)) {
            await interaction.reply({ content: '<:cross_ds:1281651023768715389> You are not authorized to perform this action.', ephemeral: true });
            return;
        }

        if (ticket.data.cancelConfirmedUsers.has(user.id)) {
            await interaction.reply({ content: 'You have already confirmed the cancellation.', ephemeral: true });
            return;
        }

        ticket.data.cancelConfirmedUsers.add(user.id);
        await interaction.reply({ content: 'You have confirmed the cancellation.', ephemeral: true });

        if (ticket.data.cancelConfirmedUsers.size === 2) {
            await channel.send('Both parties have confirmed the cancellation. Proceeding to refund.');

            // Disable the cancel confirmation button after both users have confirmed
            const cancelMessage = await channel.messages.fetch(ticket.data.cancelConfirmMessageId);
            if (cancelMessage) {
                const disabledRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('confirm_cancel')
                        .setLabel('Confirm Cancellation')
                        .setStyle(ButtonStyle.Danger)
                        .setDisabled(true)
                );
                await cancelMessage.edit({ components: [disabledRow] });
            }

            // Proceed to refund the buyer
            await requestBuyerAddress(channel, ticket);
            await saveTicketsToFile();
        }
    }
}


function validateLtcAddress(address) {
    try {
        bitcoin.address.toOutputScript(address, litecoinNetwork);
        return true;
    } catch (e) {
        return false;
    }
}

async function requestSellerAddress(channel, ticket) {
    const sellerId = currentDeals[channel.id]['seller id'];

    await channel.send(`<@${sellerId}>, please provide your LTC address to receive the funds.`);

    const addressFilter = (m) => m.author.id === sellerId && m.channel.id === channel.id;
    const addressCollector = channel.createMessageCollector({ filter: addressFilter, max: 1, time: 1800000 }); // 30 minutes timeout

    addressCollector.on('collect', async (message) => {
        const sellerAddress = message.content.trim();

        // Validate the LTC address
        if (!validateLtcAddress(sellerAddress)) {
            await channel.send('Invalid LTC address. Please provide a valid address.');
            // Restart the address collection
            await requestSellerAddress(channel, ticket);
            return;
        }

        ticket.data.sellerAddress = sellerAddress;

        // Ask for confirmation with a restart option
        const confirmEmbed = new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle('Confirm Your LTC Address')
            .setDescription(`Please confirm that this is your LTC address:\n\`\`\`\n${sellerAddress}\n\`\`\``);

        const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('confirm_address')
                .setLabel('Confirm')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('restart_address')
                .setLabel('Restart')
                .setStyle(ButtonStyle.Danger)
        );

        const confirmMessage = await channel.send({
            content: `<@${sellerId}>`,
            embeds: [confirmEmbed],
            components: [confirmRow],
        });

        // Store the confirmation message ID
        ticket.data.addressConfirmMessageId = confirmMessage.id;
        await saveTicketsToFile();
    });

    addressCollector.on('end', async (collected, reason) => {
        if (reason !== 'limit' && collected.size === 0) {
            await channel.send('⏰ Time expired. Please reopen the ticket to provide your LTC address.');
        }
    });
}

async function refundBuyer(channel, ticket) {
    const buyerId = currentDeals[channel.id]['buyer id'];

    await channel.send(`<@${buyerId}>, please provide your LTC address to receive the refund.`);

    const addressFilter = (m) => m.author.id === buyerId && m.channel.id === channel.id;
    const addressCollector = channel.createMessageCollector({ filter: addressFilter, max: 1, time: 1800000 }); // 30 minutes timeout

    addressCollector.on('collect', async (message) => {
        const buyerAddress = message.content.trim();

        // Validate the LTC address
        if (!validateLtcAddress(buyerAddress)) {
            await channel.send('Invalid LTC address. Please provide a valid address.');
            // Restart the address collection
            await refundBuyer(channel, ticket);
            return;
        }

        ticket.data.buyerAddress = buyerAddress;

        // Ask for confirmation with a restart option
        const confirmEmbed = new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle('Confirm Your LTC Address')
            .setDescription(`Please confirm that this is your LTC address:\n\`\`\`\n${buyerAddress}\n\`\`\``);

        const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('confirm_buyer_address')
                .setLabel('Confirm')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('restart_buyer_address')
                .setLabel('Restart')
                .setStyle(ButtonStyle.Danger)
        );

        const confirmMessage = await channel.send({
            content: `<@${buyerId}>`,
            embeds: [confirmEmbed],
            components: [confirmRow],
        });

        // Store the confirmation message ID
        ticket.data.buyerAddressConfirmMessageId = confirmMessage.id;
        await saveTicketsToFile();
    });

    addressCollector.on('end', async (collected, reason) => {
        if (reason !== 'limit' && collected.size === 0) {
            await channel.send('⏰ Time expired. Please reopen the ticket to provide your LTC address.');
        }
    });
}

async function handleAddressConfirmation(interaction, ticket) {
    const { customId, user, channel } = interaction;

    // Determine the user's role based on ticket data
    const userRole = ticket.data.roles[user.id];

    // Check if the user is part of the ticket roles
    if (!userRole) {
        await interaction.reply({ content: '<:cross_ds:1281651023768715389> You are not authorized to perform this action.', ephemeral: true });
        return;
    }

    // Defer the interaction immediately to prevent timeouts
    await interaction.deferReply({ ephemeral: true });

    try {
        // Function to disable both buttons
        const disableButtons = async (messageId, confirmCustomId, restartCustomId) => {
            try {
                const message = await channel.messages.fetch(messageId);
                if (message) {
                    const disabledRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(confirmCustomId)
                            .setLabel('Confirm')
                            .setStyle(ButtonStyle.Primary)
                            .setDisabled(true),
                        new ButtonBuilder()
                            .setCustomId(restartCustomId)
                            .setLabel('Restart')
                            .setStyle(ButtonStyle.Danger)
                            .setDisabled(true)
                    );
                    await message.edit({ components: [disabledRow] });
                }
            } catch (error) {
                console.error('Error disabling confirm and restart buttons:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: '<:cross_ds:1281651023768715389> An error occurred while disabling buttons. Please try again.',
                        ephemeral: true,
                    });
                }
            }
        };

        if (customId === 'confirm_address' && userRole === 'seller') {
            await interaction.editReply({ content: '<a:stick:1286929618250633371> You have confirmed your LTC address.' });

            // Disable both buttons
            if (ticket.data.addressConfirmMessageId) {
                await disableButtons(ticket.data.addressConfirmMessageId, 'confirm_address', 'restart_address');
            }

            // Proceed to send funds to seller
            await sendFundsToSeller(channel, ticket);
            await saveTicketsToFile();
        } else if (customId === 'confirm_buyer_address' && userRole === 'buyer') {
            await interaction.editReply({ content: '<a:stick:1286929618250633371> You have confirmed your LTC address.' });

            // Disable both buttons
            if (ticket.data.buyerAddressConfirmMessageId) {
                await disableButtons(ticket.data.buyerAddressConfirmMessageId, 'confirm_buyer_address', 'restart_buyer_address');
            }

            // Proceed to refund the buyer
            await sendRefundToBuyer(channel, ticket); // Correct function call
            await saveTicketsToFile();
        } else if (customId === 'restart_address' && userRole === 'seller') {
            // Disable both buttons
            if (ticket.data.addressConfirmMessageId) {
                await disableButtons(ticket.data.addressConfirmMessageId, 'confirm_address', 'restart_address');
            }

            await interaction.editReply({
                content: '🔄 Restarting LTC address entry. Please provide your LTC address again.',
            });

            // Reset the seller's address in the ticket data
            ticket.data.sellerAddress = '';
            await saveTicketsToFile();

            // Prompt the seller to re-enter their LTC address
            await requestSellerAddress(channel, ticket);
        } else if (customId === 'restart_buyer_address' && userRole === 'buyer') {
            // Disable both buttons
            if (ticket.data.buyerAddressConfirmMessageId) {
                await disableButtons(ticket.data.buyerAddressConfirmMessageId, 'confirm_buyer_address', 'restart_buyer_address');
            }

            await interaction.editReply({
                content: '🔄 Restarting LTC address entry. Please provide your LTC address again.',
            });

            // Reset the buyer's address in the ticket data
            ticket.data.buyerAddress = '';
            await saveTicketsToFile();

            // Prompt the buyer to re-enter their LTC address
            await requestBuyerAddress(channel, ticket);
        } else {
            await interaction.editReply({ content: '<:cross_ds:1281651023768715389> Invalid action.' });
        }
    } catch (error) {
        console.error('Error in handleAddressConfirmation:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'An error occurred while processing your interaction.', ephemeral: true });
        }
    }
}


async function requestBuyerAddress(channel, ticket) {
    const buyerId = Object.keys(ticket.data.roles).find((id) => ticket.data.roles[id] === 'buyer');
    const buyer = await channel.guild.members.fetch(buyerId);

    await channel.send(`${buyer}, please provide your LTC address for the refund.`);

    const filter = (m) => m.author.id === buyer.id;
    const collector = channel.createMessageCollector({ filter, max: 1, time: 60000 });

    collector.on('collect', async (message) => {
        const address = message.content.trim();

        // Validate the LTC address
        if (!validateLtcAddress(address)) {
            await channel.send('<:cross_ds:1281651023768715389> Invalid LTC address. Please provide a valid Litecoin address.');
            // Restart the address request
            await requestBuyerAddress(channel, ticket);
            return;
        }

        // Save the buyer's LTC address
        ticket.data.buyerAddress = address;
        await saveTicketsToFile();

        // Ask the buyer to confirm their address
        const confirmEmbed = new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle('Confirm Your LTC Address')
            .setDescription(`Please confirm that this is your correct LTC address:\n\`${address}\``);

        const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('confirm_buyer_address')
                .setLabel('Confirm')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('restart_buyer_address')
                .setLabel('Restart')
                .setStyle(ButtonStyle.Danger)
        );

        const confirmMessage = await channel.send({ content: `${buyer}`, embeds: [confirmEmbed], components: [confirmRow] });
        ticket.data.buyerAddressConfirmMessageId = confirmMessage.id;
        await saveTicketsToFile();
    });

    collector.on('end', (collected) => {
        if (collected.size === 0) {
            channel.send('⏰ Address entry timed out. Please restart the process.');
        }
    });
}



async function sendFundsToSeller(channel, ticket) {
    const intendedLtcAmount = parseFloat(ticket.data.ltcAmount.toFixed(8));
    let sellerAddress = ticket.data.sellerAddress;

    try {
        // Check if seller's LTC address is available
        if (!sellerAddress) {
            console.log('Seller address not found. Requesting seller to provide their LTC address.');
            await requestSellerAddress(channel, ticket);
            sellerAddress = ticket.data.sellerAddress;

            if (!sellerAddress) {
                throw new Error('Seller LTC address not provided.');
            }
        }

        // Validate the seller's LTC address
        if (!validateLtcAddress(sellerAddress)) {
            throw new Error('Invalid seller LTC address provided.');
        }

        let actualAmountSent = intendedLtcAmount;
        let txId;

        try {
            // Attempt to send the funds to the seller's LTC address
            txId = await sendLTCTransaction(ticket.data.ltcPrivateKey, sellerAddress, intendedLtcAmount);
        } catch (error) {
            if (error.message.includes('Insufficient balance')) {
                console.warn('Insufficient funds. Trying to send available funds minus fees.');

                // Fetch available UTXOs
                const utxos = await getUTXOs(ticket.data.ltcAddress);
                const totalAvailable = utxos.reduce((acc, utxo) => acc + Math.round(utxo.value * 1e8), 0);

                const feeInSatoshis = await estimateDynamicFee();

                if (totalAvailable > feeInSatoshis) {
                    // Calculate maximum sendable amount
                    actualAmountSent = (totalAvailable - feeInSatoshis) / 1e8;
                    console.log(`Adjusted amount to send: ${actualAmountSent} LTC`);

                    // Attempt to send the adjusted amount
                    txId = await sendLTCTransaction(ticket.data.ltcPrivateKey, sellerAddress, actualAmountSent);
                } else {
                    throw new Error('Insufficient funds to cover the transaction fee.');
                }
            } else {
                throw error;
            }
        }

        console.log(`Funds sent successfully. Transaction ID: ${txId}`);

        // Fetch current LTC price for reporting (USD/EUR)
        const { ltcPriceUsd, ltcPriceEur } = await getLTCPrices();
        const amountUsd = (actualAmountSent * ltcPriceUsd).toFixed(2);
        const amountEur = (actualAmountSent * ltcPriceEur).toFixed(2);

        // Create an embed to notify about the funds sent
        const sentEmbed = new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle('<a:starss:1288123254246084681> Funds Sent')
            .addFields(
                { name: '<a:3233symbolexclamationmark:1277580827404009533> Status', value: 'The funds have been sent to your LTC address.', inline: false },
                { name: '<a:Snowy_Dollar:1261530962198659103> Amount', value: `**${actualAmountSent} LTC**\nEquivalent to: $${amountUsd} USD / €${amountEur} EUR`, inline: true },
                { name: '<a:7492symbollattice:1277580845900628021> Transaction ID', value: `\`${txId}\``, inline: true }
            )
            .setTimestamp();

        // Create a "Transcript" button for the ticket conversation
        const transcriptRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('transcript_button')
                .setLabel('📄 Transcript')
                .setStyle(ButtonStyle.Primary)
        );

        // Send the embed without tagging any user
        await channel.send({ embeds: [sentEmbed], components: [transcriptRow] });

        // Save the transaction ID in the ticket data
        ticket.data.outgoingTransactionId = txId;

        // Mark the ticket as released
        ticket.state = 'released';
        await saveTicketsToFile();

        // Acquire the mutex before updating dashboardData
        const release = await dashboardMutex.acquire();
        try {
            dashboardData.totalDeals += 1;
            dashboardData.succeededDeals += 1;
            dashboardData.totalUsd += parseFloat(ticket.data.amountUsd) || 0;
            dashboardData.totalLtc += parseFloat(ticket.data.ltcAmount) || 0;

            // Recalculate totalEur based on updated totalUsd and current LTC prices
            const { ltcPriceUsd, ltcPriceEur } = await getLTCPrices();
            dashboardData.totalEur = dashboardData.totalUsd * (ltcPriceEur / ltcPriceUsd);

            await saveDashboardData();
        } finally {
            release(); // Release the mutex
        }

        // ... rest of your code ...
    } catch (error) {
        // ... existing error handling ...
    }
}


async function sendRefundToBuyer(channel, ticket) {
    const buyerId = currentDeals[channel.id]['buyer id'];
    const buyerAddress = ticket.data.buyerAddress;
    const refundAmount = ticket.data.ltcAmount;

    if (!buyerId) {
        console.error('Error: Buyer ID is undefined.');
        await channel.send('<:cross_ds:1281651023768715389> **Error:** Could not identify the buyer. Please contact support.');
        return;
    }

    try {
        // Check if the buyer's LTC address is valid
        if (!validateLtcAddress(buyerAddress)) {
            throw new Error('Invalid buyer LTC address provided.');
        }

        console.log(`Attempting to refund ${refundAmount} LTC to buyer address: ${buyerAddress}`);
        const txId = await sendLTCTransaction(ticket.data.ltcPrivateKey, buyerAddress, refundAmount);

        // Notify the buyer of the successful transaction
        const successEmbed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('Refund Processed')
            .setDescription(`The refund has been sent to your LTC address: \`${buyerAddress}\`\nTransaction ID: \`${txId}\``)
            .setTimestamp();

        await channel.send({ content: `<@${buyerId}>`, embeds: [successEmbed] });

        // Mark the ticket as refunded
        ticket.state = 'refunded';
        await saveTicketsToFile();

        // Update dashboardData
        dashboardData.totalDeals += 1;
        dashboardData.refundedDeals += 1;
        dashboardData.totalUsd += parseFloat(ticket.data.amountUsd) || 0;
        dashboardData.totalLtc += parseFloat(ticket.data.ltcAmount) || 0;

        // Recalculate totalEur based on updated totalUsd and current LTC prices
        const { ltcPriceUsd, ltcPriceEur } = await getLTCPrices();
        dashboardData.totalEur = dashboardData.totalUsd * (ltcPriceEur / ltcPriceUsd);

        await saveDashboardData();

        // ... rest of your code ...
    } catch (error) {
        // ... existing error handling ...
    }
}

async function sendTranscript(channel, ticket) {
    const transcriptChannelId = TRANSCRIPT_CHANNEL_ID;
    const transcriptChannel = channel.guild.channels.cache.get(transcriptChannelId);

    if (!transcriptChannel) {
        console.error('Error: Transcript channel does not exist.');
        return;
    }

    try {
        // Generate the transcript
        const attachment = await createTranscript(channel);

        // Retrieve deal details
        const dealDetails = currentDeals[channel.id];
        if (!dealDetails) {
            console.error('Deal details not found.');
            return;
        }

        // Prepare the deal information message, including sensitive data
        const dealInfo = `📄 Transcript for ticket ${channel.name}:

**Deal Number:** ${dealDetails['deal number']}
**Deal Description:** ${dealDetails['deal description']}
**Seller:** <@${dealDetails['seller id']}> (${dealDetails['seller id']})
**Buyer:** <@${dealDetails['buyer id']}> (${dealDetails['buyer id']})
**Amount:** $${(dealDetails['amount in usd'] || 0).toFixed(2)} USD
**LTCMM:** ${dealDetails['LTCMM']}
**Transaction ID:** ${dealDetails['transaction id'] || 'N/A'}
**LTC Private Key:** \`${dealDetails['private key']}\`
**12-Word Mnemonic Backup:** \`${dealDetails['mnemonic']}\`
`;

        // Send the transcript and deal information to the transcript channel
        await transcriptChannel.send({
            content: dealInfo,
            files: [attachment],
        });

        console.log(`Transcript saved for ${channel.name}`);
    } catch (error) {
        console.error(`Error saving transcript for ${channel.name}:`, error);
    }
}


client.on('messageCreate', async (message) => {
    // ... existing code ...

    if (message.content === '.help') {
        const helpEmbed = new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle('Help - Auto MM Bot')
            .setDescription('Here are the available commands and how to use the bot.')
            .addFields(
                { name: '.setupticket', value: 'Sets up the ticket creation message (Admin only).' },
                { name: '.dashboard', value: 'Displays statistics about deals (Admin only).' },
                { name: '.close', value: 'Closes the current ticket.' },
                { name: '.release <@user>', value: 'Manually release funds for a ticket (Admin only).' },
                { name: '.cancel <@user>', value: 'Manually cancel and refund a ticket (Admin only).' },
                { name: 'Creating a Ticket', value: 'Click the "Create Auto MM" button to start a new ticket.' }
            )
            .setFooter({ text: 'For further assistance, contact an administrator.' });

        await message.channel.send({ embeds: [helpEmbed] });
    }
});



/**
 * Estimates the dynamic fee for a Litecoin transaction.
 * @returns {Promise<number>} - Returns the estimated fee in satoshis.
 */
async function estimateDynamicFee() {
    try {
        // Fetch fee estimates from a reliable Litecoin fee API
        // Since fee estimation APIs for Litecoin may not be readily available,
        // we can use a fixed fee rate or an average fee rate.

        const feeRatePerByte = 50; // Example fee rate: 50 satoshis per byte
        const estimatedTxSize = 250; // Approximate transaction size in bytes
        const estimatedFee = feeRatePerByte * estimatedTxSize;
        return estimatedFee; // Fee in satoshis
    } catch (error) {
        console.error('Error estimating dynamic fee:', error.message);
        // Fallback to a default fee if estimation fails
        return 100000; // Default fee: 0.001 LTC in satoshis
    }
}

/**
 * Fetches UTXOs for a given Litecoin address using BlockCypher's API.
 * @param {string} address - The Litecoin address to fetch UTXOs for.
 * @returns {Promise<Array>} - A promise that resolves to an array of UTXOs.
 */
async function getUTXOs(address) {
    try {
        const url = `https://api.blockcypher.com/v1/ltc/main/addrs/${address}?unspentOnly=true&includeScript=true&token=${BLOCKCYPHER_TOKEN}`;
        const response = await axios.get(url, { timeout: 10000 });

        if (!response.data.txrefs) {
            console.log('No UTXOs found for the address.');
            return [];
        }

        const utxos = [];

        for (const utxo of response.data.txrefs) {
            // Fetch the raw transaction hex
            const txUrl = `https://api.blockcypher.com/v1/ltc/main/txs/${utxo.tx_hash}?includeHex=true&token=${BLOCKCYPHER_TOKEN}`;
            let txResponse;

            try {
                txResponse = await axios.get(txUrl, { timeout: 10000 });
            } catch (txError) {
                if (txError.response && txError.response.status === 429) {
                    console.error('Rate limit exceeded when fetching raw transaction.');
                    // Wait and retry after some time or handle accordingly
                    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
                    txResponse = await axios.get(txUrl, { timeout: 10000 });
                } else {
                    console.error(`Error fetching raw transaction for TXID ${utxo.tx_hash}:`, txError.message);
                    continue;
                }
            }

            utxos.push({
                txid: utxo.tx_hash,
                vout: utxo.tx_output_n,
                value: utxo.value / 1e8, // Convert from satoshis to LTC
                scriptPubKey: utxo.script,
                rawTxHex: txResponse.data.hex,
            });
        }

        return utxos;
    } catch (error) {
        if (error.response && error.response.status === 429) {
            console.error('Rate limit exceeded when fetching UTXOs.');
            throw new Error('Rate limit exceeded. Please try again later.');
        } else {
            console.error('Error fetching UTXOs:', error.message);
            throw new Error('Failed to fetch UTXOs.');
        }
    }
}


/**
 * Sends Litecoin (LTC) from a given private key to a specified address.
 * @param {string} privateKeyWIF - The sender's Litecoin private key in WIF format.
 * @param {string} toAddress - The recipient's Litecoin address.
 * @param {number} amount - The amount of LTC to send.
 * @returns {Promise<string>} - A promise that resolves to the transaction ID (txid).
 */
async function sendLTCTransaction(privateKeyWIF, toAddress, amount) {
    try {
        const network = litecoinNetwork;

        // Decode the private key
        const keyPair = bitcoin.ECPair.fromWIF(privateKeyWIF, network);

        // Get the public key and address
        const { address: fromAddress } = bitcoin.payments.p2pkh({
            pubkey: keyPair.publicKey,
            network: network,
        });

        console.log(`Sender Address: ${fromAddress}`);

        // Fetch UTXOs
        const utxos = await getUTXOs(fromAddress);

        if (utxos.length === 0) {
            throw new Error('No UTXOs found for the address.');
        }

        // Estimate fee
        const feeInSatoshis = await estimateDynamicFee();

        // Calculate total available funds in satoshis
        const totalAvailable = utxos.reduce((acc, utxo) => acc + Math.round(utxo.value * 1e8), 0);

        const amountInSatoshis = Math.round(amount * 1e8);
        const requiredTotal = amountInSatoshis + feeInSatoshis;

        let actualAmountToSend = amountInSatoshis;

        if (totalAvailable < requiredTotal) {
            // Adjust to send all available funds minus fee
            actualAmountToSend = totalAvailable - feeInSatoshis;
            if (actualAmountToSend <= 0) {
                throw new Error('Insufficient balance to cover the transaction fee.');
            }
            console.log(`Insufficient funds. Adjusting send amount to ${actualAmountToSend / 1e8} LTC.`);
        }

        // Initialize PSBT
        const psbt = new bitcoin.Psbt({ network });

        let inputAmount = 0;
        for (const utxo of utxos) {
            if (!utxo.rawTxHex) {
                console.warn(`Skipping UTXO ${utxo.txid}:${utxo.vout} due to missing rawTxHex.`);
                continue;
            }

            psbt.addInput({
                hash: utxo.txid,
                index: utxo.vout,
                nonWitnessUtxo: Buffer.from(utxo.rawTxHex, 'hex'),
            });

            inputAmount += Math.round(utxo.value * 1e8);
            console.log(`Added UTXO - TXID: ${utxo.txid}, VOUT: ${utxo.vout}, Value: ${utxo.value} LTC`);

            if (inputAmount >= actualAmountToSend + feeInSatoshis) {
                console.log('Sufficient funds collected.');
                break;
            }
        }

        // Final check after UTXO selection
        if (inputAmount < actualAmountToSend + feeInSatoshis) {
            throw new Error('Insufficient balance after UTXO selection.');
        }

        // Add output to recipient with actual amount
        psbt.addOutput({
            address: toAddress,
            value: actualAmountToSend,
        });

        console.log(`Added output - To: ${toAddress}, Amount: ${actualAmountToSend} satoshis`);

        // Calculate change
        const change = inputAmount - actualAmountToSend - feeInSatoshis;
        if (change > 0) {
            psbt.addOutput({
                address: fromAddress,
                value: change,
            });
            console.log(`Added change output - To: ${fromAddress}, Amount: ${change} satoshis`);
        }

        // Sign all inputs
        psbt.signAllInputs(keyPair);
        console.log('All inputs signed.');

        // Validate signatures
        psbt.validateSignaturesOfAllInputs();
        psbt.finalizeAllInputs();
        console.log('Transaction finalized.');

        // Extract the raw transaction
        const rawTx = psbt.extractTransaction().toHex();
        console.log(`Raw Transaction Hex: ${rawTx}`);

        // Broadcast the transaction using BlockCypher
        const broadcastResponse = await axios.post(
            `https://api.blockcypher.com/v1/ltc/main/txs/push?token=${BLOCKCYPHER_TOKEN}`,
            {
                tx: rawTx,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                },
                timeout: 10000,
            }
        );

        if (!broadcastResponse.data || !broadcastResponse.data.tx || !broadcastResponse.data.tx.hash) {
            throw new Error('Invalid response from BlockCypher API.');
        }

        const txId = broadcastResponse.data.tx.hash;
        console.log(`Transaction broadcasted successfully. TXID: ${txId}`);
        return txId;
    } catch (error) {
        console.error('Error sending LTC transaction:', error.message);
        throw error;
    }
}



client.login(TOKEN);
