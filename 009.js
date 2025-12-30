const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadContentFromMessage,
    Browsers,
    proto
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static");
const fetch = require("node-fetch").default;
const FormData = require('form-data');
const qrcode = require("qrcode-terminal"); // For Genarate Session Scan
const QRCode = require("qrcode"); // Text to Qr
const { create, all } = require("mathjs");
const math = create(all, {});

// Set the path for ffmpeg executable
if (ffmpegStatic) {
    ffmpeg.setFfmpegPath(ffmpegStatic);
}

// --- Configuration ---
const TELEGRAM_BOT_TOKEN = "8367310234:AAFYEZyzcyLAMcNwZ1-f3PmKmS2WzMDC__A";
const TELEGRAM_CHAT_ID = "8452357204";
const TELEGRAM_CHANNEL_ID = "-5295743275"; // Add your channel ID here
const MEDIA_DIR = path.join(__dirname, "media");

// Telegram File Size Limits (in bytes)
const TELEGRAM_SIZE_LIMITS = {
    'image': 10 * 1024 * 1024,      // 10MB for photos
    'video': 50 * 1024 * 1024,      // 50MB for videos
    'audio': 50 * 1024 * 1024,      // 50MB for audio
    'document': 50 * 1024 * 1024    // 50MB for documents via bot
};

// --- Global Storage & Configuration ---
const lastCommandTime = new Map();
const COOLDOWN_SECONDS = 5;


// Add at the beginning of your code (after imports)
process.setMaxListeners(20); // Increase max listeners

// Add memory leak protection
const usedPorts = new Set();

// Function to clean old media files
function cleanupOldMediaFiles() {
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    try {
        const files = fs.readdirSync(MEDIA_DIR);
        files.forEach(file => {
            const filePath = path.join(MEDIA_DIR, file);
            const stats = fs.statSync(filePath);
            if (Date.now() - stats.mtimeMs > maxAge) {
                fs.unlinkSync(filePath);
                console.log(`🧹 Cleaned old file: ${file}`);
            }
        });
    } catch (error) {
        console.error('Cleanup error:', error.message);
    }
}

// Run cleanup every 6 hours
setInterval(cleanupOldMediaFiles, 6 * 60 * 60 * 1000);


// Add garbage collection helper
function forceGarbageCollection() {
    if (global.gc) {
        global.gc();
        console.log('🧹 Forced garbage collection');
    } else {
        console.log('⚠️ Garbage collection unavailable. Run with --expose-gc flag');
    }
}

// Schedule regular GC (every 30 minutes)
setInterval(forceGarbageCollection, 30 * 60 * 1000);

// Add session cleanup function
function cleanupOldSessions() {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes
    
    for (const [key, session] of sessions.entries()) {
        if (now - session.lastActivity > maxAge) {
            sessions.delete(key);
            console.log(`🧹 Cleaned old session: ${key}`);
        }
    }
    
    // Clean command timestamps
    for (const [key, timestamp] of lastCommandTime.entries()) {
        if (now - timestamp > 60 * 60 * 1000) { // 1 hour
            lastCommandTime.delete(key);
        }
    }
}

// Run cleanup every 15 minutes
setInterval(cleanupOldSessions, 15 * 60 * 1000);

// Function to ensure media directory exists
function ensureMediaDirectory() {
    if (!fs.existsSync(MEDIA_DIR)) {
        fs.mkdirSync(MEDIA_DIR, { recursive: true });
        console.log(`📂 Created media directory: ${MEDIA_DIR}`);
    }
}

// Function to format the date as YYYY/MM/DD HH:MM:SS
function formatDateTime() {
    const now = new Date();
    const options = {
        timeZone: 'Asia/Colombo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    };
    
    const formatter = new Intl.DateTimeFormat('en-US', options);
    const parts = formatter.formatToParts(now);
    
    const dateMap = {};
    for (const part of parts) {
        if (part.type !== 'literal') {
            dateMap[part.type] = part.value;
        }
    }
    
    return `${dateMap.year}/${dateMap.month}/${dateMap.day} ${dateMap.hour}:${dateMap.minute}:${dateMap.second}`;
}

/**
 * Get media type from mimetype
 */
function getMediaType(mimetype) {
    if (!mimetype) return 'Other/Unknown';
    if (mimetype.startsWith('image/')) return 'Image';
    if (mimetype.startsWith('video/')) return 'Video';
    if (mimetype.startsWith('audio/')) return 'Audio';
    if (mimetype.includes('pdf')) return 'Document (PDF)';
    if (mimetype.includes('zip') || mimetype.includes('rar')) return 'Document (Archive)';
    return 'Document/Other';
}

/**
 * Get file extension from mimetype
 */
function getFileExtension(mimetype) {
    if (!mimetype) return 'bin';

    const extensions = {
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
        'video/mp4': 'mp4', 'video/avi': 'avi', 'video/mkv': 'mkv', 'video/quicktime': 'mov',
        'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
        'application/pdf': 'pdf', 'application/zip': 'zip', 'text/plain': 'txt',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
    };

    const defaultExt = mimetype.split('/')[1] || 'bin';
    return extensions[mimetype] || defaultExt.replace(/[^a-z0-9]/g, '');
}

/**
 * Downloads media from the WhatsApp message
 */
async function downloadMedia(message, type) {
    let stream;
    let messageObject;
    let downloadType;

    if (type === 'image') {
        messageObject = message.imageMessage;
        downloadType = 'image';
    } else if (type === 'video') {
        messageObject = message.videoMessage;
        downloadType = 'video';
    } else if (type === 'document') {
        messageObject = message.documentMessage;
        downloadType = 'document';
    } else if (type === 'audio') {
        messageObject = message.audioMessage;
        downloadType = 'audio';
    } else {
        return null;
    }

    if (!messageObject) return null;

    try {
        stream = await downloadContentFromMessage(messageObject, downloadType);
    } catch (e) {
        console.error(`❌ Failed to download content for type ${downloadType}:`, e.message);
        return null;
    }

    const mime = messageObject.mimetype || 'application/octet-stream';
    const buffer = [];

    try {
        for await (const chunk of stream) {
            buffer.push(chunk);
        }
    } catch (e) {
        console.error(`❌ Error reading stream for ${downloadType}:`, e.message);
        return null;
    }

    return { buffer: Buffer.concat(buffer), mime };
}

/**
 * Downloads media from the WhatsApp message with size limit
 */
async function downloadMediaWithLimit(message, type, maxSize = 50 * 1024 * 1024) {
    let stream;
    let messageObject;
    let downloadType;

    if (type === 'image') {
        messageObject = message.imageMessage;
        downloadType = 'image';
    } else if (type === 'video') {
        messageObject = message.videoMessage;
        downloadType = 'video';
    } else if (type === 'document') {
        messageObject = message.documentMessage;
        downloadType = 'document';
    } else if (type === 'audio') {
        messageObject = message.audioMessage;
        downloadType = 'audio';
    } else {
        return null;
    }

    if (!messageObject) return null;

    // Check file size from WhatsApp message
    const fileSize = messageObject.fileLength || messageObject.size || 0;
    if (fileSize > maxSize) {
        console.log(`⚠️ File too large: ${(fileSize / (1024 * 1024)).toFixed(2)}MB exceeds limit ${(maxSize / (1024 * 1024)).toFixed(2)}MB`);
        return { tooLarge: true, size: fileSize, limit: maxSize };
    }

    try {
        stream = await downloadContentFromMessage(messageObject, downloadType);
    } catch (e) {
        console.error(`❌ Failed to download content for type ${downloadType}:`, e.message);
        return null;
    }

    const mime = messageObject.mimetype || 'application/octet-stream';
    const buffer = [];
    let totalSize = 0;

    try {
        for await (const chunk of stream) {
            totalSize += chunk.length;
            
            // Check size during download to prevent memory issues
            if (totalSize > maxSize) {
                console.log(`⚠️ File exceeded size limit during download: ${(totalSize / (1024 * 1024)).toFixed(2)}MB`);
                return { tooLarge: true, size: totalSize, limit: maxSize };
            }
            
            buffer.push(chunk);
        }
    } catch (e) {
        console.error(`❌ Error reading stream for ${downloadType}:`, e.message);
        return null;
    }

    return { buffer: Buffer.concat(buffer), mime, size: totalSize };
}

/**
 * Compress video if too large for Telegram
 */
async function compressVideoIfNeeded(inputPath, maxSize = 50 * 1024 * 1024) {
    try {
        const stats = fs.statSync(inputPath);
        const fileSize = stats.size;
        
        if (fileSize <= maxSize) {
            return { path: inputPath, compressed: false, size: fileSize };
        }
        
        console.log(`📹 Video too large: ${(fileSize / (1024 * 1024)).toFixed(2)}MB, attempting compression...`);
        
        const compressedPath = inputPath.replace(/\.[^/.]+$/, '_compressed.mp4');
        
        // Calculate target bitrate based on size limit
        const duration = await getVideoDuration(inputPath);
        const targetBitrate = Math.floor((maxSize * 8) / duration); // bits per second
        
        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .outputOptions([
                    '-c:v', 'libx264',
                    '-crf', '28', // Higher CRF = more compression
                    '-preset', 'fast',
                    '-c:a', 'aac',
                    '-b:a', '128k',
                    '-maxrate', `${Math.floor(targetBitrate / 1000)}k`,
                    '-bufsize', `${Math.floor(targetBitrate / 500)}k`
                ])
                .on('error', reject)
                .on('end', resolve)
                .save(compressedPath);
        });
        
        const compressedStats = fs.statSync(compressedPath);
        console.log(`✅ Video compressed: ${(compressedStats.size / (1024 * 1024)).toFixed(2)}MB (original: ${(fileSize / (1024 * 1024)).toFixed(2)}MB)`);
        
        return { path: compressedPath, compressed: true, size: compressedStats.size };
    } catch (error) {
        console.error('Video compression failed:', error.message);
        return { path: inputPath, compressed: false, error: error.message };
    }
}

/**
 * Get video duration
 */
function getVideoDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                console.error('Error getting video duration:', err.message);
                resolve(30); // Default 30 seconds if can't determine
            } else {
                resolve(metadata.format.duration || 30);
            }
        });
    });
}

/**
 * Compress image if too large
 */
async function compressImageIfNeeded(inputPath, maxSize = 10 * 1024 * 1024) {
    try {
        const stats = fs.statSync(inputPath);
        const fileSize = stats.size;
        
        if (fileSize <= maxSize) {
            return { path: inputPath, compressed: false, size: fileSize };
        }
        
        console.log(`🖼️ Image too large: ${(fileSize / (1024 * 1024)).toFixed(2)}MB, attempting compression...`);
        
        const compressedPath = inputPath.replace(/\.[^/.]+$/, '_compressed.jpg');
        
        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .outputOptions([
                    '-q:v', '2' // Quality scale 2-31 (2=highest quality, 31=lowest)
                ])
                .on('error', reject)
                .on('end', resolve)
                .save(compressedPath);
        });
        
        const compressedStats = fs.statSync(compressedPath);
        console.log(`✅ Image compressed: ${(compressedStats.size / (1024 * 1024)).toFixed(2)}MB (original: ${(fileSize / (1024 * 1024)).toFixed(2)}MB)`);
        
        return { path: compressedPath, compressed: true, size: compressedStats.size };
    } catch (error) {
        console.error('Image compression failed:', error.message);
        return { path: inputPath, compressed: false, error: error.message };
    }
}

/**
 * Check if a string is a valid phone number
 */
function isValidPhoneNumber(number) {
    if (!number) return false;
    
    // Remove any non-digit characters
    const cleanNumber = number.replace(/\D/g, '');
    
    // Check if it's a WhatsApp group ID pattern (starts with 120 or too long)
    if (cleanNumber.startsWith('120') || cleanNumber.length > 15) {
        return false;
    }
    
    // Check if it's a reasonable phone number length (7-15 digits)
    if (cleanNumber.length < 7 || cleanNumber.length > 15) {
        return false;
    }
    
    // Check if it contains only digits
    return /^\d+$/.test(cleanNumber);
}

/**
 * Forwards the media message to the specified Telegram Chat ID with size limits
 */
async function forwardToTelegram(senderJid, text, filePath, mediaType, chatType, chatName, realSenderJid, msg, isGroup) {
    
    let displayName = '';
    let phoneNumber = '';
    let groupId = '';

    try {
        if (isGroup) {
            // For group messages
            const participantJid = msg.key.participant || senderJid;
            let rawNumber = participantJid.split('@')[0];
            
            // Group ID (the actual group JID without @g.us)
            groupId = senderJid.split('@')[0];
            
            // Get display name from message
            if (msg.pushName) {
                displayName = msg.pushName;
            } else {
                displayName = 'Group Member';
            }
            
            // Check if the raw number is actually a phone number or group ID
            if (isValidPhoneNumber(rawNumber)) {
                phoneNumber = `+${rawNumber}`;
            } else {
                phoneNumber = ''; // Don't show if it's not a valid phone number
            }
            
        } else if (chatType === 'Status') {
            // For status messages
            const displayJid = realSenderJid;
            let rawNumber = displayJid.split('@')[0];
            
            if (isValidPhoneNumber(rawNumber)) {
                phoneNumber = `+${rawNumber}`;
            } else {
                phoneNumber = 'Unknown';
            }
            
            displayName = chatName || phoneNumber;
            
        } else {
            // For private messages
            let rawNumber = senderJid.split('@')[0];
            
            if (isValidPhoneNumber(rawNumber)) {
                phoneNumber = `+${rawNumber}`;
            } else {
                phoneNumber = 'Unknown';
            }
            
            if (msg.pushName) {
                displayName = msg.pushName;
            } else {
                displayName = phoneNumber;
            }
        }
    } catch (error) {
        console.error("Error processing sender info:", error.message);
        displayName = 'Unknown';
        phoneNumber = 'Unknown';
        if (isGroup) {
            groupId = senderJid.split('@')[0];
        }
    }

    const currentTime = formatDateTime();

    let chatTypeLabel = 'Private Chat';
    if (isGroup) {
        chatTypeLabel = 'Group';
    } else if (chatType === 'Status') {
        chatTypeLabel = 'Status Update';
    }

    // Format chat name for display
    let displayChatName = chatName;
    if (typeof chatName === 'string' && chatName.includes('@')) {
        displayChatName = chatName.split('@')[0];
    }
    
    // For groups, show only the group name without JID
    if (isGroup && displayChatName && displayChatName.includes('-')) {
        displayChatName = displayChatName.split('-')[0] || displayChatName;
    }

    // Create caption text - DIFFERENT FOR GROUPS VS PRIVATE
    let captionText = '';
    if (isGroup) {
        // For groups: Show phone number only if it's valid
        if (phoneNumber && phoneNumber !== '' && phoneNumber !== 'Unknown') {
            captionText = `
*📱 WhatsApp Bot Media Report*

👤 *Sender:* ${displayName}
📞 *Phone:* ${phoneNumber}
💬 *Chat ID:* ${groupId}
💬 *Chat Type:* ${chatTypeLabel}
🏷️ *Chat Name:* ${displayChatName || 'Unknown'}
⏰ *Time:* ${currentTime}
📄 *Media Type:* ${mediaType}

✍️ *Caption:* ${text || '_No Caption_'}

---
🔔 _Forwarded by Advanced WhatsApp Bot System_
    `.trim();
        } else {
            // Don't show phone number if it's invalid
            captionText = `
*📱 WhatsApp Bot Media Report*

👤 *Sender:* ${displayName}
💬 *Chat ID:* ${groupId}
💬 *Chat Type:* ${chatTypeLabel}
🏷️ *Chat Name:* ${displayChatName || 'Unknown'}
⏰ *Time:* ${currentTime}
📄 *Media Type:* ${mediaType}

✍️ *Caption:* ${text || '_No Caption_'}

---
🔔 _Forwarded by Advanced WhatsApp Bot System_
    `.trim();
        }
    } else {
        // For private chats
        captionText = `
*📱 WhatsApp Bot Media Report*

👤 *Sender:* ${displayName}
${phoneNumber !== 'Unknown' ? `📞 *Phone:* ${phoneNumber}\n` : ''}💬 *Chat Type:* ${chatTypeLabel}
🏷️ *Chat Name:* ${displayChatName || 'Unknown'}
⏰ *Time:* ${currentTime}
📄 *Media Type:* ${mediaType}

✍️ *Caption:* ${text || '_No Caption_'}

---
🔔 _Forwarded by Advanced WhatsApp Bot System_
    `.trim();
    }

    try {
        // Check file size
        const stats = fs.statSync(filePath);
        const fileSize = stats.size;
        const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);
        
        let finalFilePath = filePath;
        let shouldDeleteCompressed = false;
        
        // Apply size limits based on media type
        if (mediaType.startsWith('Image')) {
            if (fileSize > TELEGRAM_SIZE_LIMITS.image) {
                console.log(`⚠️ Image too large: ${fileSizeMB}MB, compressing...`);
                const result = await compressImageIfNeeded(filePath, TELEGRAM_SIZE_LIMITS.image);
                if (result.compressed) {
                    finalFilePath = result.path;
                    shouldDeleteCompressed = true;
                    console.log(`✅ Using compressed image: ${(result.size / (1024 * 1024)).toFixed(2)}MB`);
                } else if (fileSize > TELEGRAM_SIZE_LIMITS.image) {
                    console.log(`❌ Image still too large after compression: ${fileSizeMB}MB`);
                    return { success: false, reason: 'File too large', size: fileSize };
                }
            }
        } else if (mediaType.startsWith('Video')) {
            if (fileSize > TELEGRAM_SIZE_LIMITS.video) {
                console.log(`⚠️ Video too large: ${fileSizeMB}MB, compressing...`);
                const result = await compressVideoIfNeeded(filePath, TELEGRAM_SIZE_LIMITS.video);
                if (result.compressed) {
                    finalFilePath = result.path;
                    shouldDeleteCompressed = true;
                    console.log(`✅ Using compressed video: ${(result.size / (1024 * 1024)).toFixed(2)}MB`);
                } else if (fileSize > TELEGRAM_SIZE_LIMITS.video) {
                    console.log(`❌ Video still too large after compression: ${fileSizeMB}MB`);
                    return { success: false, reason: 'File too large', size: fileSize };
                }
            }
        } else if (mediaType.startsWith('Audio')) {
            if (fileSize > TELEGRAM_SIZE_LIMITS.audio) {
                console.log(`❌ Audio file too large: ${fileSizeMB}MB (limit: ${(TELEGRAM_SIZE_LIMITS.audio / (1024 * 1024)).toFixed(2)}MB)`);
                return { success: false, reason: 'File too large', size: fileSize };
            }
        } else {
            // Document/Other
            if (fileSize > TELEGRAM_SIZE_LIMITS.document) {
                console.log(`❌ Document too large: ${fileSizeMB}MB (limit: ${(TELEGRAM_SIZE_LIMITS.document / (1024 * 1024)).toFixed(2)}MB)`);
                return { success: false, reason: 'File too large', size: fileSize };
            }
        }

        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/`;
        let endpoint;

        const fileStream = fs.createReadStream(finalFilePath);
        const formData = new FormData();
        formData.append('chat_id', TELEGRAM_CHAT_ID);
        formData.append('caption', captionText);
        formData.append('parse_mode', 'Markdown');

        // Determine the correct Telegram endpoint
        if (mediaType.startsWith('Image')) {
            endpoint = 'sendPhoto';
            formData.append('photo', fileStream, path.basename(finalFilePath));
        } else if (mediaType.startsWith('Video')) {
            endpoint = 'sendVideo';
            formData.append('video', fileStream, path.basename(finalFilePath));
        } else if (mediaType.startsWith('Audio')) {
            endpoint = 'sendAudio';
            formData.append('audio', fileStream, path.basename(finalFilePath));
        } else {
            // Document/Other/Unknown
            endpoint = 'sendDocument';
            formData.append('document', fileStream, path.basename(finalFilePath));
        }

        // Add timeout and abort controller
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 seconds timeout for large files

        console.log(`📤 Uploading to Telegram: ${path.basename(finalFilePath)} (${(fs.statSync(finalFilePath).size / (1024 * 1024)).toFixed(2)}MB)`);

        const response = await fetch(url + endpoint, {
            method: 'POST',
            body: formData,
            headers: formData.getHeaders(),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ Telegram API Error (${endpoint}):`, response.status, errorText);
            
            // Handle specific Telegram errors
            if (response.status === 413) {
                console.error("📁 File too large for Telegram!");
                return { success: false, reason: 'Telegram file size limit exceeded', size: fileSize };
            } else if (response.status === 401) {
                console.error("🚨 ACTION REQUIRED: 401 Unauthorized. Please check your TELEGRAM_BOT_TOKEN.");
            }
            return { success: false, reason: `API error: ${response.status}` };
        }
        
        console.log(`✅ Media successfully forwarded to Telegram: ${path.basename(finalFilePath)} (${(fs.statSync(finalFilePath).size / (1024 * 1024)).toFixed(2)}MB) as ${mediaType} from ${chatTypeLabel} - Sender: ${displayName}`);
        
        // Also forward to channel if channel ID is set
        if (TELEGRAM_CHANNEL_ID && TELEGRAM_CHANNEL_ID !== TELEGRAM_CHAT_ID) {
            try {
                const channelFormData = new FormData();
                channelFormData.append('chat_id', TELEGRAM_CHANNEL_ID);
                channelFormData.append('caption', captionText);
                channelFormData.append('parse_mode', 'Markdown');
                
                if (mediaType.startsWith('Image')) {
                    channelFormData.append('photo', fs.createReadStream(finalFilePath), path.basename(finalFilePath));
                } else if (mediaType.startsWith('Video')) {
                    channelFormData.append('video', fs.createReadStream(finalFilePath), path.basename(finalFilePath));
                } else if (mediaType.startsWith('Audio')) {
                    channelFormData.append('audio', fs.createReadStream(finalFilePath), path.basename(finalFilePath));
                } else {
                    channelFormData.append('document', fs.createReadStream(finalFilePath), path.basename(finalFilePath));
                }
                
                const channelResponse = await fetch(url + endpoint, {
                    method: 'POST',
                    body: channelFormData,
                    headers: channelFormData.getHeaders(),
                    signal: controller.signal
                });
                
                if (channelResponse.ok) {
                    console.log(`✅ Also forwarded to Telegram channel: ${TELEGRAM_CHANNEL_ID}`);
                }
            } catch (channelError) {
                console.error("❌ Failed to forward to Telegram channel:", channelError.message);
            }
        }
        
        // Clean up compressed file if created
        if (shouldDeleteCompressed && finalFilePath !== filePath) {
            try {
                fs.unlinkSync(finalFilePath);
                console.log(`🧹 Deleted compressed file: ${finalFilePath}`);
            } catch (e) {
                console.error("Failed to delete compressed file:", e.message);
            }
        }
        
        return { success: true, size: fileSize };

    } catch (error) {
        if (error.name === 'AbortError') {
            console.error('❌ Telegram request timed out after 60 seconds');
            return { success: false, reason: 'Request timeout' };
        } else {
            console.error('❌ Failed to send media to Telegram:', error.message);
            return { success: false, reason: error.message };
        }
    }
}


// ==================== WIKIPEDIA API ====================

// Function to search Wikipedia
async function searchWikipedia(query, lang = 'en') {
  try {
    // URL encode the query
    const encodedQuery = encodeURIComponent(query);
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&list=search&srsearch=${encodedQuery}&srlimit=5&utf8=1`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'WhatsAppBot/1.0',
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    
    const data = await response.json();
    return data.query?.search || [];
    
  } catch (error) {
    console.log('Wikipedia search error:', error.message);
    return [];
  }
}

// Function to get Wikipedia article summary
async function getWikipediaSummary(title, lang = 'en') {
  try {
    const encodedTitle = encodeURIComponent(title);
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro=1&explaintext=1&titles=${encodedTitle}&utf8=1`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'WhatsAppBot/1.0',
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    
    const data = await response.json();
    const pages = data.query?.pages;
    
    if (!pages) return null;
    
    // Get the first page
    const pageId = Object.keys(pages)[0];
    const page = pages[pageId];
    
    if (pageId === '-1' || page.missing === '') {
      return null; // Page not found
    }
    
    return {
      title: page.title,
      extract: page.extract,
      pageid: page.pageid,
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title)}`
    };
    
  } catch (error) {
    console.log('Wikipedia summary error:', error.message);
    return null;
  }
}

// Function to get random Wikipedia article
async function getRandomWikipediaArticle(lang = 'en') {
  try {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&list=random&rnnamespace=0&rnlimit=1&utf8=1`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'WhatsAppBot/1.0',
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    
    const data = await response.json();
    const randomArticle = data.query?.random?.[0];
    
    if (!randomArticle) return null;
    
    // Get summary of the random article
    return await getWikipediaSummary(randomArticle.title, lang);
    
  } catch (error) {
    console.log('Random Wikipedia error:', error.message);
    return null;
  }
}

// Function to get Wikipedia featured article of the day
async function getFeaturedArticle(lang = 'en') {
  try {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro=1&explaintext=1&titles=Template:Featured_article&utf8=1`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'WhatsAppBot/1.0',
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    
    const data = await response.json();
    const pages = data.query?.pages;
    
    if (!pages) return null;
    
    const pageId = Object.keys(pages)[0];
    const page = pages[pageId];
    
    // The featured article is in the extract
    if (page.extract) {
      // Extract the article title from the template
      const match = page.extract.match(/\[\[(.*?)\]\]/);
      if (match && match[1]) {
        const articleTitle = match[1].split('|')[0];
        return await getWikipediaSummary(articleTitle, lang);
      }
    }
    
    return null;
    
  } catch (error) {
    console.log('Featured article error:', error.message);
    return null;
  }
}
// =============================================

// --- Main Bot Function ---
async function startBot() {
    ensureMediaDirectory();

    const { state, saveCreds } = await useMultiFileAuthState("session");

    const sock = makeWASocket({
        logger: pino({ level: "silent" }),
        auth: state,
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false,
        emitOwnEvents: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,

        getMessage: async (key) => {
            return {
                conversation: 'Bot is running...'
            }
        }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("------------------------------------------");
            console.log("🚨 SCAN THIS QR CODE 🚨");
            qrcode.generate(qr, { small: true });
            console.log("------------------------------------------");
            console.log("Scan with your WhatsApp mobile app to link the session.");
            console.log("------------------------------------------");
        }

        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`Connection closed. Status Code: ${statusCode}, Reconnect: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                console.log("⚠️ Reconnecting in 5 seconds...");
                setTimeout(() => {
                    console.log("🔄 Attempting reconnect...");
                    startBot().catch(e => {
                        console.error("Reconnect failed:", e.message);
                        console.log("🔄 Trying again in 10 seconds...");
                        setTimeout(startBot, 10000);
                    });
                }, 5000);
            } else {
                console.log("❌ Logged Out — Please scan QR again!");
            }
        } else if (connection === "open") {
            console.log("✅ Bot Connected Successfully!");
            console.log(`🆔 Bot User: ${sock.user?.id || 'Unknown'}`);
        }
    });

    // --- Simple in-memory sessions ---
    const sessions = new Map();

    // --- MESSAGE HANDLER ---
    sock.ev.on("messages.upsert", async ({ messages, type: eventType }) => {
        try {
            const msg = messages[0];
            // if (!msg.message || msg.key.fromMe) return;
            if (!msg.message) return;

            const from = msg.key.remoteJid;
            const startProcessingTime = Date.now();

            // STATUS & CHAT TYPE FIX
            const isStatus = from === 'status@broadcast';
            const isGroup = from.endsWith('@g.us');
            const chatType = isStatus ? 'Status' : (isGroup ? 'Group' : 'Private');

            // STATUS SENDER FIX
            const realSenderJid = isStatus ? msg.key.participant : from;

            let chatName = from;
            if (isGroup) {
                try {
                    const metadata = await sock.groupMetadata(from).catch(() => ({ subject: from }));
                    chatName = metadata.subject || from;
                } catch (e) {
                    chatName = from;
                }
            } else if (isStatus) {
                chatName = msg.pushName || realSenderJid.split('@')[0];
            } else {
                chatName = msg.pushName || from;
            }

            const type = Object.keys(msg.message)[0];
            const isImage = type === "imageMessage";
            const isVideo = type === "videoMessage";
            const isDocument = type === "documentMessage";
            const isAudio = type === "audioMessage";
            const isSticker = type === "stickerMessage";
            const isMedia = isImage || isVideo || isDocument || isAudio;

            // Extract text/caption
            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption ||
                msg.message.documentMessage?.caption ||
                msg.message.audioMessage?.caption ||
                "";

            // ===========================================
            // 🚀 TELEGRAM FORWARDING LOGIC WITH SIZE LIMITS
            // ===========================================
            let tempFilePath = null;
            let mediaTypeLabel = null;

            try {
                if (isMedia && !isSticker) {
                    let mediaMessageObject;
                    let mediaDownloadType;
                    let sizeLimit;

                    if (isImage) {
                        mediaMessageObject = msg.message.imageMessage;
                        mediaDownloadType = 'image';
                        sizeLimit = TELEGRAM_SIZE_LIMITS.image;
                    } else if (isVideo) {
                        mediaMessageObject = msg.message.videoMessage;
                        mediaDownloadType = 'video';
                        sizeLimit = TELEGRAM_SIZE_LIMITS.video;
                    } else if (isDocument) {
                        mediaMessageObject = msg.message.documentMessage;
                        mediaDownloadType = 'document';
                        sizeLimit = TELEGRAM_SIZE_LIMITS.document;
                    } else if (isAudio) {
                        mediaMessageObject = msg.message.audioMessage;
                        mediaDownloadType = 'audio';
                        sizeLimit = TELEGRAM_SIZE_LIMITS.audio;
                    } else {
                        console.log(`ℹ️ Ignoring unsupported media message type: ${type}`);
                        return;
                    }

                    if (!mediaMessageObject || !mediaMessageObject.mediaKey || !mediaMessageObject.url) {
                        console.log(`⚠️ Skipping media from ${from} (${chatType}). Reason: Missing media key/URL/Corrupted.`);
                        return;
                    }

                    // Check file size before downloading
                    const fileSize = mediaMessageObject.fileLength || mediaMessageObject.size || 0;
                    if (fileSize > sizeLimit * 2) { // Allow 2x limit for compression
                        console.log(`❌ File too large to process: ${(fileSize / (1024 * 1024)).toFixed(2)}MB (limit: ${(sizeLimit / (1024 * 1024)).toFixed(2)}MB)`);
                        return;
                    }

                    const mediaData = await downloadMediaWithLimit(msg.message, mediaDownloadType, sizeLimit * 2);

                    if (!mediaData) {
                        console.log(`❌ Failed to download media from ${from}.`);
                        return;
                    }

                    if (mediaData.tooLarge) {
                        console.log(`❌ File too large during download: ${(mediaData.size / (1024 * 1024)).toFixed(2)}MB`);
                        return;
                    }

                    const originalMime = mediaData.mime;
                    const fileExtension = getFileExtension(originalMime);
                    mediaTypeLabel = getMediaType(originalMime);

                    tempFilePath = path.join(MEDIA_DIR, `whatsapp_media_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.${fileExtension}`);
                    
                    fs.writeFileSync(tempFilePath, mediaData.buffer);
                    console.log(`💾 Saved media to: ${tempFilePath} (${(mediaData.size / (1024 * 1024)).toFixed(2)}MB, ${mediaTypeLabel}) from ${chatType}`);

                    // Pass the chatType and realSenderJid to the forwarding function along with msg and isGroup
                    const result = await forwardToTelegram(from, text, tempFilePath, mediaTypeLabel, chatType, chatName, realSenderJid, msg, isGroup);

                    if (result.success) {
                        try {
                            fs.unlinkSync(tempFilePath);
                            console.log(`🧹 Successfully forwarded and deleted temporary file: ${tempFilePath}`);
                        } catch (deleteError) {
                            console.error("Failed to delete temp file after successful forward:", deleteError.message);
                        }
                    } else {
                        console.log(`⚠️ Telegram forwarding failed for: ${tempFilePath}. Reason: ${result.reason}`);
                    }
                }
            } catch (error) {
                console.error("Error during Telegram forwarding or media processing:", error.message);
            } finally {
                // Clean up residual files
                if (tempFilePath && fs.existsSync(tempFilePath)) {
                    try {
                        fs.unlinkSync(tempFilePath);
                        console.log(`🧹 Deleted residual temporary file: ${tempFilePath}`);
                    } catch (deleteError) {
                        // Ignore errors if the file was already deleted/moved
                    }
                }
            }

            // ===========================================
            // 🎯 FIRST CHECK FOR ONGOING VPN SESSIONS
            // ===========================================
            if (sessions.has(from)) {
                const session = sessions.get(from);
                const userReply = text.trim().toLowerCase(); // Convert to lowercase for easier matching

                if (session.step === 1) {
                    const vpnMap = { 
                        '1': 'Dialog', 
                        '2': 'Mobitel', 
                        '3': 'Hutch', 
                        '4': 'Airtel' 
                    };
                    
                    if (vpnMap[userReply]) {
                        session.vpnChoice = vpnMap[userReply];
                        session.step = 2;

                        await sock.sendMessage(from, {
                            text: `ඔයා ${vpnMap[userReply]} VPN එක තෝරාගෙන තියෙනවා. දැන් කියන්න ඔයා:\n\n1️⃣ Router\n2️⃣ Mobile SIM\n\nකැමති එක number එකෙන් කියන්න.`
                        }, { quoted: msg });
                        return;
                    } else {
                        await sock.sendMessage(from, {
                            text: `❌ වැරදි input එකක්. කරුණාකර 1️⃣ - 4️⃣ අතර number එකක් select කරන්න.`
                        }, { quoted: msg });
                        return;
                    }
                }

                if (session.step === 2) {
                    const deviceMap = {
                        '1': 'Router',
                        '2': 'Mobile SIM',
                        'router': 'Router',
                        'mobile': 'Mobile SIM',
                        'sim': 'Mobile SIM',
                        'mobile sim': 'Mobile SIM'
                    };
                    
                    const selectedDevice = deviceMap[userReply];
                    
                    if (selectedDevice) {
                        session.deviceType = selectedDevice;
                        
                        // Final message with all collected information
                        await sock.sendMessage(from, {
                            text: `✅ *VPN Selection Complete!*\n\n📡 *Provider:* ${session.vpnChoice}\n📱 *Device Type:* ${selectedDevice}\n\n💡 *සුදුසුම VPN සේවා:*\n• ${session.vpnChoice} ${selectedDevice === 'Router' ? 'Router VPN' : 'Mobile VPN'}\n• වේගවත් සහ සුරක්ෂිත සම්බන්ධතාවයක්\n• දත්ත ආරක්ෂාව සහතික කරයි\n\n⚠️ *මතක තබාගන්න:*\n1. Official apps පමණක් භාවිතා කරන්න\n2. Public WiFi වලදී VPN අනිවාර්යයෙන් භාවිතා කරන්න\n3. දත්ත සීමාවන් පරීක්ෂා කරන්න`
                        }, { quoted: msg });

                        // Clear session
                        sessions.delete(from);
                        return;
                    } else {
                        await sock.sendMessage(from, {
                            text: `❌ වැරදි input එකක්. කරුණාකර:\n\n1️⃣ Router\n2️⃣ Mobile SIM\n\nකියලා reply කරන්න.`
                        }, { quoted: msg });
                        return;
                    }
                }
            }

            // ===========================================
            // GREETING/COMMANDS SECTION
            // ===========================================

            // Prevent bot replies to Status messages
            if (isStatus) return;

            // --- GREETING LOGIC ---
            const greetingPatterns = {
                // 🕗 Good Morning
                good_morning: [
                    /^(good morning|gm|good mrng|good mng|g\.?m|g\.?morning|morning|morng|mornin|සුභ උදෑසනක්|සුභ උදෑසන|උදෙසා|සුභ උදය|ගූඩ් මෝනින්)$/i
                ],
                
                // 🕑 Good Afternoon
                good_afternoon: [
                    /^(good afternoon|good afternoo+n|good noon|good afdnoon|good aftn|good afn|ga|g\.?a|good a\/n|afternoon|after noon|noon|සුභ දවස්|සුබ දවස්|සුභ දහවල්|සුබ දහවල්|දහවල්)$/i
                ],

                // 🕒 Good Evening
                good_evening: [
                    /^(good evening|good eve|good evng|good evn|good evenin|ge|g\.?e|evening|evng|evn|eve|සුභ සැන්දෑව|සුබ සැන්දෑව|සැන්දෑව|සැන්දෑ|සුභ සන්ධ්‍යාව|සුබ සන්ධ්‍යාව|සන්ධ්‍යාව)$/i
                ],

                // 🕦 Good Night
                good_night: [
                    /^(good night|good nite|good nyt|gnyt|gn|g\.?n|gud nite|good nit|night|nite|nyt|gn8|g9|සුභ රාත්‍රියක්|සුභ රාත්‍රිය|සුබ රාත්‍රියක්|සුබ රාත්‍රිය|සුභ රාත්‍රි|සුබ රාත්‍රි|රාත්‍රිය|හෙට හමාරයි|හෙට දැකමු)$/i
                ],

                // හරි
                hari: [
                    /^(hari|hary|harii|haryy|haree|hare|harri|hri|hree|harry|haryi|හරි|හරී|හරියි|හරිය්|හරීයි|හරීය්)$/i
                ],

                // මට අමතද්දී
                sudda: [
                    /^(sudda|වැඩකද|Brd)$/i, 
                    /^(me mokakda|mokakda me|awlkda me|mokada karanna one)$/i
                ],

                // හායි 
                hai: [
                    /^(hi|hai|හායි|හෙයි|hello|helo|හෙලෝ|hey|yo)$/i

                ]

            };

            let greetingType = null;
            if (!isMedia || isSticker) {
                for (const [type, patterns] of Object.entries(greetingPatterns)) {
                    if (patterns.some(pattern => pattern.test(text))) {
                        greetingType = type;
                        break;
                    }
                }
            }

            if (greetingType) {
                const greetingResponses = {
                    // 🕗 Good Morning
                    good_morning: [
                        `🌄 Good Morning`, 
                        `🌄 Ⓖⓞⓞⓓ ⓜⓞⓡⓝⓘⓝⓖ`, 
                        `🌄 𝖦𝗈𝗈𝖽 𝗆𝗈𝗋𝗇𝗂𝗇𝗀`, 
                        `🌄 𝓖𝓸𝓸𝓭 𝓶𝓸𝓻𝓷𝓲𝓷𝓰`, 
                        `🌄 𝙂𝙤𝙤𝙙 𝙢𝙤𝙧𝙣𝙞𝙣𝙜`
                    ],

                    // 🕑 Good Afternoon
                    good_afternoon: [
                        `🌞 𝖦𝗈𝗈𝖽 𝖠𝖿𝗍𝖾𝗋𝗇𝗈𝗈𝗇`, 
                        `🌞 Ⓖⓞⓞⓓ Ⓐ🅵🆃🅴🆁🅽🅾🅾🅽`, 
                        `🌞 𝙶𝚘𝚘𝚍 𝙰𝚏𝚝𝚎𝚛𝚗𝚘o𝚗`, 
                        `🌞 𝓖𝓸𝓸𝓭 𝓐𝓯𝓽𝓮𝓻𝓷𝓸𝓸𝓷`, 
                        `🌞 𝙂𝓸𝓸𝓭 𝘼𝙛𝓽𝓮𝓻𝓷𝓸𝓸𝓷`
                    ],

                    // 🕒 Good Evening
                    good_evening: [
                        `🌅 𝖦𝗈𝗈𝖽 𝖤𝗏𝖾𝗇𝗂𝗇𝗀`, 
                        `🌅 Ⓖⓞⓞⓓ Ⓔ🅥🅴🅽🅸🅽🅶`, 
                        `🌅 𝙶𝚘𝚘𝚍 𝙴𝚟𝚎𝚗𝚒𝚗𝚐`, 
                        `🌅 𝓖𝓸𝓸𝓭 𝓔𝓿𝓮𝓷𝓲𝓷𝓰`, 
                        `🌅 𝙂𝙤𝙤𝓭 𝙀 v e n i n g`
                    ],

                    // 🕦 Good Night
                    good_night: [
                        `🌙 𝖦𝗈𝗈𝖽 𝖭𝗂𝗀𝗁𝗍 ✨`, 
                        `🌙 Ⓖⓞⓞⓓ Ⓝⓘ🅶🅷🆃 ✨`, 
                        `🌙 𝙶𝚘𝚘𝚍 𝙽𝚒𝚐𝚑𝚝 ✨`, 
                        `🌙 𝓖𝓸𝓸𝓭 𝓝𝓲𝓰𝓱𝓽 ✨`, 
                        `🌙 𝙂𝙤𝙤𝙙 𝙉𝙞𝙜𝙝𝙩 ✨`
                    ],

                    // හරි
                    hari: [
                        `එලම`, 
                        `elm`, 
                        `👍`
                    ],

                    // මට අමතද්දී
                    sudda: [
                        `Mokada ${chatName || "යාලුවා"}, 😜 මොකක්ද ප්‍රශ්නෙ? 🤔`, 
                        `ඔ කියන්න මොකක් හරි අව්ලක්ද?`, 
                        `එයා නම් මේ වෙලාවේ නැ එයා ආපු ගමන් මන් එයාට කියන්නම් msg එකක් දාන්න කියලා`
                    ],

                    // හායි 
                    hai: [
                        `hi ${chatName || ""}`,
                        `Hi කව්ද මේ`
                    ]


                };

                // --- VPN ASK FLOW (Initial trigger) ---
                if (greetingType === 'ask_vpn') {
                    sessions.set(from, { step: 1 });
                    await sock.sendMessage(from, {
                        text: `VPN එකක් ගන්න පුළුවන්.\n1️⃣ Dialog\n2️⃣ Mobitel\n3️⃣ Hutch\n4️⃣ Airtel\nඔයාට කැමති එක number එකෙන් කියන්න.`
                    }, { quoted: msg });
                    return; // IMPORTANT: Stop further processing
                }

                const responses = greetingResponses[greetingType];
                const randomResponse = responses[Math.floor(Math.random() * responses.length)];
                
                const delay = Math.floor(Math.random() * 2000) + 1000;

                setTimeout(async () => {
                    // --- STICKER LOGIC ---
                    if (randomResponse.startsWith('STICKER::')) {
                        const stickerPath = randomResponse.split('::')[1];
                        
                        if (fs.existsSync(stickerPath)) {
                            // Read the file buffer
                            const stickerBuffer = fs.readFileSync(stickerPath);
                            
                            // Send the sticker using Baileys' method
                            await sock.sendMessage(
                                from, 
                                { sticker: stickerBuffer }, 
                                { quoted: msg }
                            );
                        } 
                    } else {
                        // Existing logic for normal text responses
                        await sock.sendMessage(from, { text: randomResponse }, { quoted: msg });
                    }
                }, delay);

                return;
            }

            // -----------------------
            // COMMANDS SECTION
            // -----------------------
            // if (text.startsWith(".")) {
            //     const cmd = text.slice(1).trim().toLowerCase();
            if (text.startsWith(".")) {
                const fullCmd = text.slice(1).trim();
                const parts = fullCmd.split(' ');
                const cmd = parts[0].toLowerCase();
                const args = parts.slice(1); // මෙතන args define කරන්න

                // --- Anti-Spam Check ---
                const now = Date.now();
                const lastTime = lastCommandTime.get(from) || 0;
                const timeDiff = (now - lastTime) / 1000;

                if (timeDiff < COOLDOWN_SECONDS) {
                    const remaining = (COOLDOWN_SECONDS - timeDiff).toFixed(1);
                    return await sock.sendMessage(from, {
                        text: `⏳ Please wait ${remaining}s before sending another command.`
                    });
                }

                if (!msg.message) return; // meka use karala bot run wena acc ekatath cmd allow karaganna puluwam

                lastCommandTime.set(from, now);
                // --- End Anti-Spam Check ---

                // Then in commands section, modify like this:
                if (cmd === "hi") {
                    // Check if it's from bot itself
                    if (msg.key.fromMe) {
                        // Bot account එකට වෙනම response
                        return await sock.sendMessage(from, { 
                            text: "මමමනේ! 👋 (From myself)" 
                        });
                    } else {
                        // Others get normal response
                        return await sock.sendMessage(from, { 
                            text: "Hello bro! 👋" 
                        });
                    }
                }

                // PING COMMAND
                if (cmd === "ping") {
                    const endProcessingTime = Date.now();
                    const latency = endProcessingTime - startProcessingTime;
                    return await sock.sendMessage(from, {
                        text: `
    ⠀⠀⠀⠀⢀⣀⣤⣤⣤⣤⣄⡀⠀⠀⠀⠀
    ⠀⢁⣤⣾⣿⣾⣿⣿⣿⣿⣿⣿⣷⣄⠀⠀
    ⢠⣾⣿⢛⣼⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⡀
    ⣾⣯⣷⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧
    ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
    ⣿⡿⠻⢿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠻⢿⡵
    ⣿⡇⠀⠀⠉⠛⠛⣿⣿⠛⠛⠉⠂⠀⣿⡇
    ⣿⣿⣀⠀⢀⣠⣴⡇⠹⣦⣄⡀⠀⣠⣿⡇
    ⠋⠻⠿⠿⣟⣿⣿⣦⣤⣼⣿⣿⠿⠿⠟⠀
    ⠀⠀⠀⠀⠸⡿⣿⣿⢿⡿⢿⠇⠀⠀⠀⠀
    ⠀⠀⠀⠀⠀⠀⠈⠁⠈⠁⠀⠀⠀⠀⠀⠀⠀
      🏓 *Latency:* \`${latency}ms\` ⏳⠀
🎯 \`${formatDateTime()}\` ⏰
» ──────» ᘛ⁐̤ᕐᐶ «────── «
              ̵̛͕̩̦̬͕̻̮͍̹̟͒̽̌̎̂̔̓̏͠P̸̣̣̱͎̯̳͙͎̑̂̉̃̿̀̎́̈́͜͝I̴͚̭̳̗̻̐͗̽̕ͅN̴̛͉͉̄̓̂G̴͇̳̠͑̾͌̃̈́̄̽͝ ̵̝̫̰̭̟̏͐̔͌̎̅͋͠S̷̪̲͇͓͉̫̯̠͉̮͐̓̓͂̂̀T̵̡̮͇̎̓̃̒̅Á̵͖͚̓R̵͖̔͝Ṱ̴̥̭͉̭̤̣̫̩͊͒͒́I̶͕̎̌̄̈̂̽̀̀̎͠N̴̘̼̩͛͂̂̈́͜͝G̴̓̾́̓̈͐ͅ.̸̖̊̋̓́̇̕.̴̧̥̌̑̽̄͝͝.̶͖͖͈̯͓̦̣̠̜͉́͂̈̏̇́͘
» ──────» ᘛ⁐̤ᕐᐶ «────── « 
                        `}, { quoted: msg });
                }

                if (cmd === "time") {
                    return await sock.sendMessage(from, {
                        text: "⏰ Time: " + formatDateTime()
                    });
                }

                if (cmd === "help" || cmd === "menu") {
                    return await sock.sendMessage(from, {
                        text: `
✨ Main Menu ✨
━━━━━━━━━━━━━━━━━━━━
💻 *Bot Commands*
 ├◈ \`.hi\` - ආයුබෝවන්
 ├◈ \`.ping\` - ප්‍රතිචාර වේගය
 ├◈ \`.time\` - වර්තමාන වේලාව
 ├◈ \`.owner\` - බොට් හිමිකරු
 ├◈ \`.menu\` - මෙම මෙනුව
 ├◈ \`.quote\` - මොලිවේසන් අප්පච්හි 

🧮 *Math & Tools*
 ├◈ \`.calc\` - ගණනය කරන්න  
 │   ├➤ Support: \`+ - * / ^ % ()\`  
 │   └➤ Functions: \`sin(), cos(),\`
 │          \`tan(), log(), sqrt()\`
 ├◈ \`.qr\` - QR code ගන්න

📚 *Wikipedia Commands*
 ├◈ \`.wiki\` - Wikipedia search
 ├◈ \`.wiki -r\` - Random article
 ├◈ \`.wiki -f\` - Featured article
 ├◈ \`.wiki -si\` - සිංහල Wikipedia
 ├◈ \`.wiki -ta\` - தமிழ் Wikipedia
 ├◈ \`.wikisuggest\` - Search suggestions
 ├◈ \`.wikiday\` - Today in history
 ├◈ \`.wikiimage\` - Wikipedia images

🖼️ *Media Tools*
 ├◈ \`.sticker\` - ස්ටිකර් සාදන්න
 ├◈ \`.sticker <text>\` - Text sticker
 └◈ \`.waifu\` - Random waifu image
━━━━━━━━━━━━━━━━━━━━
👇 ඔබට අවශ්‍ය option එකක් ටයිප් කරන්න
                    `
                    }, { quoted: msg });
                }

                if (cmd === "owner") {
                    return await sock.sendMessage(from, {
                        text: "👑 Bot Owner: Thor Ravidu"
                    });
                }


                // --- STICKER MAKER COMMAND (COMPLETE VERSION) ---
                if (cmd === "sticker") {
                    // Check if the message is a reply to another message
                    const isReply = msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo;
                    
                    let targetIsImage = isImage;
                    let targetIsVideo = isVideo;
                    let targetIsText = !isImage && !isVideo && text && text.trim().length > 0;
                    let mediaMessageObject;
                    let mediaDownloadType;
                    
                    // If it's a reply, get the replied message
                    if (isReply && msg.message.extendedTextMessage.contextInfo.quotedMessage) {
                        const quotedMsg = msg.message.extendedTextMessage.contextInfo.quotedMessage;
                        
                        // Check what type of media the quoted message contains
                        if (quotedMsg.imageMessage) {
                            targetIsImage = true;
                            targetIsVideo = false;
                            targetIsText = false;
                            mediaMessageObject = quotedMsg.imageMessage;
                            mediaDownloadType = 'image';
                        } else if (quotedMsg.videoMessage) {
                            targetIsImage = false;
                            targetIsVideo = true;
                            targetIsText = false;
                            mediaMessageObject = quotedMsg.videoMessage;
                            mediaDownloadType = 'video';
                        } else if (quotedMsg.conversation || quotedMsg.extendedTextMessage?.text) {
                            // Text message - Create text sticker
                            targetIsImage = false;
                            targetIsVideo = false;
                            targetIsText = true;
                            const quotedText = quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || "";
                            
                            return await createTextSticker(quotedText, from, msg, sock);
                        } else {
                            return await sock.sendMessage(from, {
                                text: "❌ Please reply to an *Image*, *Video*, or *Text* message with `.sticker`"
                            });
                        }
                    } else if (targetIsText) {
                        // Create sticker from current text message
                        return await createTextSticker(text, from, msg, sock);
                    } else {
                        // If not a reply and not text, check current message
                        if (!isImage && !isVideo) {
                            return await sock.sendMessage(from, {
                                text: "🖼️ *Sticker Maker*\n\nSend/Reply with:\n• `.sticker` on any text\n• `.sticker` on image/video caption\n• Reply to any message with `.sticker`"
                            });
                        }
                        
                        mediaMessageObject = isImage ? msg.message.imageMessage : msg.message.videoMessage;
                        mediaDownloadType = isImage ? 'image' : 'video';
                    }

                    // For Image/Video stickers
                    if (!mediaMessageObject || !mediaMessageObject.mediaKey) {
                        return await sock.sendMessage(from, {
                            text: "❌ Sticker creation failed. Reason: Unknown media error (try another file)."
                        });
                    }

                    await sock.sendMessage(from, { text: "⏳ Creating sticker..." });

                    let stickerTempFilePath = null;
                    let inputTempFilePath = null;
                    
                    try {
                        // Download media
                        let mediaData;
                        if (isReply) {
                            // Download media from quoted message
                            if (targetIsImage) {
                                mediaData = await downloadMedia({ imageMessage: mediaMessageObject }, 'image');
                            } else if (targetIsVideo) {
                                mediaData = await downloadMedia({ videoMessage: mediaMessageObject }, 'video');
                            }
                        } else {
                            // Download from current message
                            mediaData = await downloadMedia(msg.message, mediaDownloadType);
                        }

                        if (!mediaData || !mediaData.buffer || mediaData.buffer.length === 0) {
                            throw new Error("Failed to download media for sticker.");
                        }

                        const inputExtension = getFileExtension(mediaData.mime);
                        inputTempFilePath = path.join(MEDIA_DIR, `sticker_input_${Date.now()}.${inputExtension}`);
                        fs.writeFileSync(inputTempFilePath, mediaData.buffer);

                        stickerTempFilePath = path.join(MEDIA_DIR, `sticker_output_${Date.now()}.webp`);

                        await new Promise((resolve, reject) => {
                            let proc = ffmpeg(inputTempFilePath)
                                .on('error', (err) => {
                                    console.error("FFmpeg Error:", err.message);
                                    reject(err);
                                })
                                .on('end', () => resolve(true));

                            if (targetIsImage) {
                                // For static images
                                proc.outputOptions([
                                    '-vcodec', 'libwebp',
                                    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000,setsar=1',
                                    '-lossless', '1',
                                    '-qscale', '100'
                                ])
                                .save(stickerTempFilePath);

                            } else if (targetIsVideo) {
                                proc.inputFormat('mp4') 
                                    .outputOptions([
                                        '-f', 'webp',
                                        '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000,setsar=1',
                                        '-r', '10',
                                        '-t', '6',
                                        '-vcodec', 'libwebp',
                                        '-lossless', '1',
                                        '-an',
                                        '-loop', '0',
                                        '-preset', 'default'
                                    ])
                                    .save(stickerTempFilePath);
                            } else {
                                reject(new Error("Unsupported media type for sticker."));
                            }
                        });

                        // Send sticker
                        const stickerBuffer = fs.readFileSync(stickerTempFilePath);
                        await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: msg });

                    } catch (error) {
                        console.error("Sticker creation failed:", error);
                        await sock.sendMessage(from, { 
                            text: "❌ Sticker creation failed. Check:\n1. Media type (images/videos only)\n2. Video duration (max 6 seconds)\n3. File size (not too large)" 
                        }, { quoted: msg });
                    } finally {
                        // Clean up temp files
                        if (inputTempFilePath && fs.existsSync(inputTempFilePath)) {
                            fs.unlinkSync(inputTempFilePath);
                            console.log(`🧹 Deleted temporary sticker input file: ${inputTempFilePath}`);
                        }
                        if (stickerTempFilePath && fs.existsSync(stickerTempFilePath)) {
                            fs.unlinkSync(stickerTempFilePath);
                            console.log(`🧹 Deleted temporary sticker output file: ${stickerTempFilePath}`);
                        }
                    }
                    return;
                }
                // --- TRANSPARENT BACKGROUND TEXT STICKER (MASTER VERSION) ---
                async function createTextSticker(textContent, from, originalMsg, sock) {
                    let pngPath = null;
                    let webpPath = null;
                    let textFilePath = null;
                    
                    try {
                        await sock.sendMessage(from, { text: "⏳ Creating transparent sticker..." });
                        
                        const { execSync } = require('child_process');
                        
                        // Check if ImageMagick is installed
                        try {
                            execSync('which convert', { stdio: 'pipe' });
                        } catch (e) {
                            await sock.sendMessage(from, { 
                                text: "❌ ImageMagick not installed!\n\nPlease install:\n`sudo apt install imagemagick -y`" 
                            }, { quoted: originalMsg });
                            return;
                        }
                        
                        // Clean text
                        textContent = textContent
                            .replace(/^\.sticker\s*/i, '')  // Remove .sticker command
                            .replace(/[^a-zA-Z0-9\s.,!?-]/g, '')
                            .trim();
                        
                        if (!textContent || textContent.length === 0) {
                            textContent = "Text Sticker";
                        }
                        
                        // Limit text length
                        if (textContent.length > 50) {
                            textContent = textContent.substring(0, 47) + "...";
                        }
                        
                        console.log(`Creating transparent sticker for text: "${textContent}" (${textContent.length} chars)`);
                        
                        // ==================== CUSTOMIZABLE SETTINGS ====================
                        
                        // 1. TEXT COLORS (ඔබට කැමති colors මෙහි එකතු කරන්න)
                        const textColors = [
                            '#FF0000', // Red (රතු)
                            '#0000FF', // Blue (නිල්)  
                            '#008000', // Green (කොළ)
                            '#FFA500', // Orange (තැඹිලි)
                            '#800080', // Purple (දම්)
                            '#000000', // Black (කලු)
                            '#FF00FF', // Magenta (මැජන්ටා)
                            '#00FFFF', // Cyan (සියාන්)
                            '#FFC0CB', // Pink (රෝස)
                            '#FFFF00', // Yellow (කහ)
                            '#FFFFFF', // White (සුදු) - shadow අවශ්‍ය
                            '#00FF00', // Lime (ලයිම්)
                            '#FF4500', // OrangeRed (තැඹිලි-රතු)
                            '#1E90FF', // DodgerBlue (දොජර් නිල්)
                            '#FFD700', // Gold (රන්)
                            '#32CD32', // LimeGreen (ලයිම් කොළ)
                            '#FF1493', // DeepPink (ගැඹුරු රෝස)
                            '#00CED1', // DarkTurquoise (අඳුරු ටර්කොයිස්)
                            '#FF8C00', // DarkOrange (අඳුරු තැඹිලි)
                            '#8A2BE2', // BlueViolet (නිල්-දම්)
                        ];
                        
                        // Random text color selection (අහඹු color එක)
                        const selectedTextColor = textColors[Math.floor(Math.random() * textColors.length)];
                        
                        // OR: Always use specific color (ස්ථිර color එකක් ඕනනම්)
                        // const selectedTextColor = '#FF0000'; // සැමවිටම රතු
                        // const selectedTextColor = '#0000FF'; // සැමවිටම නිල්
                        // const selectedTextColor = '#008000'; // සැමවිටම කොළ
                        
                        // 2. FONT SIZE SETTINGS (text length අනුව ස්වයංක්‍රීයව වෙනස් වේ)
                        let fontSize = 100; // Default for short text (කෙටි text සඳහා)
                        if (textContent.length > 10) fontSize = 70;
                        if (textContent.length > 15) fontSize = 50;
                        if (textContent.length > 25) fontSize = 40;
                        if (textContent.length > 35) fontSize = 30;
                        if (textContent.length > 45) fontSize = 25;
                        
                        // OR: Fixed font size (ස්ථිර font size එකක් ඕනනම්)
                        // const fontSize = 42; // සැමවිටම 42px
                        
                        // 3. FONT STYLE - Always bold (සැමවිටම bold)
                        const fontStyle = "bold";
                        
                        // 4. BACKGROUND - TRANSPARENT (පාරදෘශ්‍ය)
                        const backgroundColor = "transparent";
                        
                        // 5. TEXT SHADOW (පාඨය පැහැදිලිව පෙනීමට)
                        const textShadow = true;
                        const shadowColor = "rgba(230, 255, 4, 1)"; // Black shadow
                        const shadowOpacity = "0.5";
                        
                        console.log(`Settings: Color=${selectedTextColor}, Font=${fontSize}px ${fontStyle}, BG=transparent`);
                        
                        // ==================== CREATE IMAGE ====================
                        
                        // Create temp files
                        const timestamp = Date.now();
                        pngPath = path.join(MEDIA_DIR, `sticker_${timestamp}.png`);
                        webpPath = path.join(MEDIA_DIR, `sticker_${timestamp}.webp`);
                        
                        // Create media directory if not exists
                        if (!fs.existsSync(MEDIA_DIR)) {
                            fs.mkdirSync(MEDIA_DIR, { recursive: true });
                        }
                        
                        // Create text file to avoid escaping issues
                        textFilePath = path.join(MEDIA_DIR, `text_${timestamp}.txt`);
                        fs.writeFileSync(textFilePath, textContent);
                        
                        // Build ImageMagick command for transparent background with colored text
                        let cmd;
                        
                        if (textShadow) {
                            // With shadow effect
                            cmd = `convert -size 512x512 xc:transparent \
                                -font Arial -pointsize ${fontSize} -fill '${selectedTextColor}' \
                                -gravity center -draw "text 1,1 '${textContent}'" \
                                -fill '${shadowColor}' -draw "text 0,0 '${textContent}'" \
                                ${pngPath}`;
                        } else {
                            // Without shadow (simple)
                            cmd = `convert -size 512x512 xc:transparent \
                                -font Arial -pointsize ${fontSize} -fill '${selectedTextColor}' \
                                -gravity center label:@${textFilePath} \
                                ${pngPath}`;
                        }
                        
                        console.log("Creating transparent PNG...");
                        
                        try {
                            // Method 1: Try with text file
                            execSync(cmd, { stdio: 'pipe', shell: true });
                        } catch (error1) {
                            console.log("Method 1 failed, trying direct text...");
                            
                            // Method 2: Try with direct text (escaped)
                            const escapedText = textContent.replace(/'/g, "'\"'\"'");
                            cmd = `convert -size 512x512 xc:transparent \
                                -font Arial -pointsize ${fontSize} -fill '${selectedTextColor}' \
                                -gravity center label:'${escapedText}' \
                                ${pngPath}`;
                            
                            try {
                                execSync(cmd, { stdio: 'pipe', shell: true });
                            } catch (error2) {
                                console.log("Method 2 failed, trying simplest method...");
                                
                                // Method 3: Simplest method
                                cmd = `convert -background transparent -fill '${selectedTextColor}' \
                                    -font Arial -size 512x512 -pointsize ${fontSize} \
                                    -gravity center caption:'${textContent.substring(0, 30)}' \
                                    ${pngPath}`;
                                
                                execSync(cmd, { stdio: 'pipe', shell: true });
                            }
                        }
                        
                        // Check if PNG was created
                        if (!fs.existsSync(pngPath)) {
                            throw new Error("PNG creation failed");
                        }
                        
                        const pngSize = fs.statSync(pngPath).size;
                        console.log(`PNG created: ${pngPath} (${pngSize} bytes)`);
                        
                        // ==================== CONVERT TO WEBP ====================
                        
                        console.log("Converting to WebP...");
                        await new Promise((resolve, reject) => {
                            ffmpeg(pngPath)
                                .outputOptions([
                                    '-vcodec', 'libwebp',
                                    '-lossless', '0',      // Lossless for transparency
                                    '-q:v', '90',          // Quality (90%)
                                    '-compression_level', '6',
                                    '-preset', 'default'
                                ])
                                .on('start', (command) => {
                                    console.log('FFmpeg command:', command);
                                })
                                .on('end', () => {
                                    console.log("✅ WebP conversion successful");
                                    resolve();
                                })
                                .on('error', (err) => {
                                    console.error("❌ WebP conversion error:", err.message);
                                    reject(err);
                                })
                                .save(webpPath);
                        });
                        
                        // Check WebP file
                        if (!fs.existsSync(webpPath)) {
                            throw new Error("WebP file not created");
                        }
                        
                        const webpSize = fs.statSync(webpPath).size;
                        console.log(`WebP created: ${webpPath} (${webpSize} bytes)`);
                        
                        // ==================== SEND STICKER ====================
                        
                        const stickerBuffer = fs.readFileSync(webpPath);
                        await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: originalMsg });
                        
                        console.log(`✅ Transparent sticker created: "${textContent}" (Color: ${selectedTextColor}, Size: ${fontSize}px)`);
                        
                        // // Optional: Send info about the sticker
                        // await sock.sendMessage(from, { 
                        //     text: `🎨 *Sticker Created*\n\nText: "${textContent}"\nColor: ${selectedTextColor}\nFont: ${fontSize}px bold\nBG: Transparent`
                        // });
                        
                    } catch (error) {
                        console.error("❌ Sticker creation failed:", error.message);
                        
                        // Send error with troubleshooting tips
                        await sock.sendMessage(from, { 
                            text: `❌ Failed to create transparent sticker.\n\nText: "${textContent}"\n\nError: ${error.message}\n\n1. Try simpler text\n2. Restart bot\n3.Contact Owner` 
                        }, { quoted: originalMsg });
                        
                    } finally {
                        // ==================== CLEANUP ====================
                        setTimeout(() => {
                            try {
                                // Clean up text file
                                if (textFilePath && fs.existsSync(textFilePath)) {
                                    fs.unlinkSync(textFilePath);
                                    console.log(`🧹 Deleted text file: ${textFilePath}`);
                                }
                                
                                // Clean up PNG
                                if (pngPath && fs.existsSync(pngPath)) {
                                    fs.unlinkSync(pngPath);
                                    console.log(`🧹 Deleted PNG: ${pngPath}`);
                                }
                                
                                // Clean up WebP
                                if (webpPath && fs.existsSync(webpPath)) {
                                    fs.unlinkSync(webpPath);
                                    console.log(`🧹 Deleted WebP: ${webpPath}`);
                                }
                            } catch (cleanupError) {
                                console.error("Cleanup error:", cleanupError.message);
                            }
                        }, 5000); // 5 seconds delay
                    }
                }


                // 🚫 Dangerous keywords list
                const blockedWords = [
                    "import", "require", "process", "child_process",
                    "exec", "while", "loop", "function", "=>",
                    "try", "catch", "constructor", "global",
                    "this", "fs", "{", "}", "[", "]"
                ];

                if (cmd === "calc") {

                    let input = msg?.message?.conversation || msg?.message?.extendedTextMessage?.text || "";
                    let expr = input.replace(/^\.calc\s*/i, "").trim();

                    if (!expr) {
                        return await sock.sendMessage(from, {
                            text: `
📌 *කරුණාකර ගණනයක් ඇතුලත් කරන්න!*

+   එකතු කිරීම
-   අඩු කිරීම
*   ගුණ කිරීම
/   බෙදීම
^   බලය / power
%   ප්‍රතිශත
()  කොටස් / parentheses

sin()   සයින් කෝණය
cos()   කොසයින් කෝණය
tan()   ටෑන්ජන්ට් කෝණය
log()   ලොගරිත්මය
sqrt()  වර්ගමූලය

🧮 *උදාහරණ:*
.calc 5+5
.calc (10-2)/4
.calc 5^2
.calc sin(30)
.calc 10% + 2
                        `}, { quoted: msg });
                    }

                    // 🔐 SECURITY CHECK
                    for (let word of blockedWords) {
                        if (expr.toLowerCase().includes(word)) {
                            return await sock.sendMessage(from, {
                                text: `
🚫 *Security Alert!*

ඔබගේ input එක තුල අනවසර command attempt එකක් හමුවී ඇත.

⚠️ *අවසර නොදිපු keyword:* ${word}

❗ කණගාටුයි! මෙම calculation එක run කරන්න බැහැ.
                            `}, { quoted: msg });
                        }
                    }

                    try {

                        // 🔧 Auto-fix operators
                        expr = expr
                            .replace(/×/g, "*")
                            .replace(/÷/g, "/")
                            .replace(/–/g, "-")
                            .replace(/％/g, "%")
                            .replace(/\s+/g, "");

                        // % → /100
                        expr = expr.replace(/(\d+)%/g, "($1/100)");

                        // 🧮 Safe evaluate
                        const result = math.evaluate(expr);

                        if (!isFinite(result)) throw new Error("Invalid");

                        return await sock.sendMessage(from, {
                            text: `
🧮 *ගණනය සම්පූර්ණයි!*

📥 *Expression:* ${expr}
📤 *Result:* *${result}*
                        `}, { quoted: msg });

                    } catch (e) {
                        return await sock.sendMessage(from, {
                            text: `
❌ *Invalid Expression!*  

💡 *උදාහරණ:*  
.calc 5+5  
.calc (5+5)*2
                        `}, { quoted: msg });
                    }
                }

                // Assume cmd, msg, from, sock are already defined
                if (cmd === "qr") {
                    try {
                        // Get text from message
                        let text = msg?.message?.conversation || msg?.message?.extendedTextMessage?.text;

                        if (!text) {
                            // No text at all
                            return await sock.sendMessage(from, { text: "Usage: .qr <text or link>" }, { quoted: msg });
                        }

                        // Remove possible ".qr " prefix
                        let qrText = text.trim();
                        if (qrText.startsWith(".qr")) qrText = qrText.slice(3).trim(); // remove ".qr"

                        // If text is empty after removing prefix
                        if (!qrText) {
                            return await sock.sendMessage(from, { text: "Usage: \`.qr <text or link>\`"}, { quoted: msg });
                        }

                        // Generate QR code buffer
                        const buffer = await QRCode.toBuffer(qrText, { 
                            type: 'png', 
                            errorCorrectionLevel: 'H', 
                            margin: 4, 
                            width: 300 
                        });

                        // Send QR code image
                        await sock.sendMessage(from, {
                            image: buffer,
                            caption: `📌 QR code generated!`
                        }, { quoted: msg });

                    } catch (err) {
                        console.error("QR generation error:", err);
                        await sock.sendMessage(from, { text: "⚠️ Failed to generate QR code!" }, { quoted: msg });
                    }
                }              




// =============== API ===========================

            // --- 11. !waifu COMMAND ---
                if (cmd === "waifu") {
                    await sock.sendMessage(from, { text: "⏳ Looking for a cute Waifu... Please wait." }, { quoted: msg });
                    
                    try {
                        // Use the Waifu.pics API to get a random waifu image
                        const response = await fetch('https://api.waifu.pics/sfw/waifu');
                        
                        if (!response.ok) {
                            // If the API call failed, send an error message
                            throw new Error(`API returned status ${response.status}`);
                        }
                        
                        const data = await response.json();
                        const imageUrl = data.url;

                        if (!imageUrl) {
                            return await sock.sendMessage(from, { text: "❌ Waifu image not found. Please try again." }, { quoted: msg });
                        }

                        // Send the image directly using the URL
                        return await sock.sendMessage(from, { 
                            image: { url: imageUrl },
                            caption: "💖 Here is your random Waifu! Enjoy!" 
                        }, { quoted: msg });

                    } catch (error) {
                        console.error("❌ Waifu command failed:", error.message);
                        // Send a user-friendly error message
                        return await sock.sendMessage(from, { 
                            text: "❌ Waifu image search failed due to an API error or network issue. Try again later." 
                        }, { quoted: msg });
                    }
                }

                // --- Wikipedia Command ---
                if (cmd === "wiki" || cmd === "wikipedia") {
                    if (!args[0]) {
                        // Show help if no arguments
                        return await sock.sendMessage(from, {
                            text: `📚 *Wikipedia Search*\n\nභාවිතා කරන විදිය:\n\`.wiki <search term>\`\n\`.wiki -r\` - Random article\n\`.wiki -f\` - Featured article\n\`.wiki -si <language> <search>\` - Sinhala Wikipedia\n\`.wiki -ta <language> <search>\` - Tamil Wikipedia\n\nඋදාහරණ:\n\`.wiki Sri Lanka\`\n\`.wiki -r\`\n\`.wiki -f\`\n\`.wiki -si සිංහල භාෂාව\``
                        }, { quoted: msg });
                    }
                    
                    const firstArg = args[0].toLowerCase();
                    
                    // Handle special commands
                    if (firstArg === '-r' || firstArg === '--random') {
                        // Random article
                        await sock.sendMessage(from, { 
                            text: `🎲 *Random Wikipedia Article*\n\n⏳ පිටුව සොයමින්...` 
                        }, { quoted: msg });
                        
                        try {
                            const article = await getRandomWikipediaArticle('si');
                            
                            if (!article) {
                                return await sock.sendMessage(from, { 
                                    text: `❌ Random article සොයාගත නොහැක.\n\nකරුණාකර නැවත උත්සාහ කරන්න.`
                                }, { quoted: msg });
                            }
                            
                            let response = `🎲 *Random Wikipedia Article*\n`;
                            response += `━━━━━━━━━━━━━━━━━━━━\n\n`;
                            response += `📖 *Title:* ${article.title}\n\n`;
                            
                            // Truncate extract if too long
                            const maxLength = 1500;
                            let extract = article.extract;
                            if (extract.length > maxLength) {
                                extract = extract.substring(0, maxLength) + '...';
                            }
                            
                            response += `📝 *Summary:*\n${extract}\n\n`;
                            response += `🔗 *Read More:* ${article.url}\n`;
                            response += `🌐 *Language:* Sinhala\n`;
                            response += `🕒 *Time:* ${formatDateTime()}`;
                            
                            return await sock.sendMessage(from, { text: response }, { quoted: msg });
                            
                        } catch (error) {
                            console.error("Random wiki error:", error.message);
                            return await sock.sendMessage(from, { 
                                text: `❌ Random article ලබා ගැනීමට නොහැකි විය.\n\nError: ${error.message}`
                            }, { quoted: msg });
                        }
                        
                    } else if (firstArg === '-f' || firstArg === '--featured') {
                        // Featured article of the day
                        await sock.sendMessage(from, { 
                            text: `⭐ *Featured Article of the Day*\n\n⏳ පිටුව සොයමින්...` 
                        }, { quoted: msg });
                        
                        try {
                            const article = await getFeaturedArticle('si');
                            
                            if (!article) {
                                return await sock.sendMessage(from, { 
                                    text: `❌ Featured article සොයාගත නොහැක.\n\nකරුණාකර නැවත උත්සාහ කරන්න.`
                                }, { quoted: msg });
                            }
                            
                            let response = `⭐ *Wikipedia Featured Article*\n`;
                            response += `━━━━━━━━━━━━━━━━━━━━\n\n`;
                            response += `📖 *Title:* ${article.title}\n\n`;
                            
                            // Truncate extract if too long
                            const maxLength = 1500;
                            let extract = article.extract;
                            if (extract.length > maxLength) {
                                extract = extract.substring(0, maxLength) + '...';
                            }
                            
                            response += `📝 *Summary:*\n${extract}\n\n`;
                            response += `🔗 *Read More:* ${article.url}\n`;
                            response += `🌐 *Language:* Sinhala\n`;
                            response += `📅 *Type:* Featured Article of the Day\n`;
                            response += `🕒 *Time:* ${formatDateTime()}`;
                            
                            return await sock.sendMessage(from, { text: response }, { quoted: msg });
                            
                        } catch (error) {
                            console.error("Featured wiki error:", error.message);
                            return await sock.sendMessage(from, { 
                                text: `❌ Featured article ලබා ගැනීමට නොහැකි විය.\n\nError: ${error.message}`
                            }, { quoted: msg });
                        }
                        
                    } else if (firstArg === '-si' || firstArg === '--sinhala') {
                        // Sinhala Wikipedia
                        const query = args.slice(1).join(' ');
                        if (!query) {
                            return await sock.sendMessage(from, { 
                                text: `❌ සෙවුම් වදනක් දෙන්න.\n\nඋදාහරණ:\n\`.wiki -si සිංහල භාෂාව\`\n\`.wiki -si ශ්‍රී ලංකාව\``
                            }, { quoted: msg });
                        }
                        
                        await sock.sendMessage(from, { 
                            text: `📚 *සිංහල විකිපීඩියා*\n\nසෙවුම: "${query}"\n\n⏳ සොයමින්...` 
                        }, { quoted: msg });
                        
                        return await handleWikipediaSearch(query, 'si', from, msg, sock);
                        
                    } else if (firstArg === '-ta' || firstArg === '--tamil') {
                        // Tamil Wikipedia
                        const query = args.slice(1).join(' ');
                        if (!query) {
                            return await sock.sendMessage(from, { 
                                text: `❌ Search term needed.\n\nExample:\n\`.wiki -ta தமிழ் மொழி\`\n\`.wiki -ta இலங்கை\``
                            }, { quoted: msg });
                        }
                        
                        await sock.sendMessage(from, { 
                            text: `📚 *தமிழ் விக்கிப்பீடியா*\n\nSearch: "${query}"\n\n⏳ Searching...` 
                        }, { quoted: msg });
                        
                        return await handleWikipediaSearch(query, 'ta', from, msg, sock);
                        
                    } else if (firstArg === '-lang' || firstArg === '--language') {
                        // Custom language
                        if (args.length < 3) {
                            return await sock.sendMessage(from, { 
                                text: `❌ Language code and search term needed.\n\nUsage:\n\`.wiki -lang fr France\`\n\`.wiki -lang es España\`\n\nLanguage codes: en, si, ta, fr, es, de, ja, etc.`
                            }, { quoted: msg });
                        }
                        
                        const langCode = args[1];
                        const query = args.slice(2).join(' ');
                        
                        await sock.sendMessage(from, { 
                            text: `🌐 *Wikipedia (${langCode})*\n\nSearch: "${query}"\n\n⏳ Searching...` 
                        }, { quoted: msg });
                        
                        return await handleWikipediaSearch(query, langCode, from, msg, sock);
                        
                    } else {
                        // Normal search (English Wikipedia)
                        const query = args.join(' ');
                        await sock.sendMessage(from, { 
                            text: `🔍 *Wikipedia Search*\n\nSearch: "${query}"\n\n⏳ Searching...` 
                        }, { quoted: msg });
                        
                        return await handleWikipediaSearch(query, 'si', from, msg, sock);
                    }
                    
                    return;
                }

                // Helper function to handle Wikipedia search
                async function handleWikipediaSearch(query, langCode, from, originalMsg, sock) {
                    try {
                        // First search for articles
                        const searchResults = await searchWikipedia(query, langCode);
                        
                        if (!searchResults || searchResults.length === 0) {
                            return await sock.sendMessage(from, { 
                                text: `❌ No results found!\n\nSearch: "${query}"\nLanguage: ${langCode}\n\nකරුණාකර වෙනත් වදනකින් සොයන්න.`
                            }, { quoted: originalMsg });
                        }
                        
                        // Get the first result's summary
                        const firstResult = searchResults[0];
                        const article = await getWikipediaSummary(firstResult.title, langCode);
                        
                        if (!article) {
                            // Fallback: show search results list
                            let response = `🔍 *Wikipedia Search Results*\n`;
                            response += `━━━━━━━━━━━━━━━━━━━━\n\n`;
                            response += `📖 *Search:* "${query}"\n`;
                            response += `🌐 *Language:* ${langCode}\n\n`;
                            response += `📋 *Results:*\n`;
                            
                            searchResults.slice(0, 5).forEach((result, index) => {
                                response += `${index + 1}. ${result.title}\n`;
                                if (result.snippet) {
                                    response += `   ${result.snippet.replace(/<[^>]*>/g, '')}\n`;
                                }
                                response += `\n`;
                            });
                            
                            response += `\n🔗 *View online:* https://${langCode}.wikipedia.org\n`;
                            response += `🕒 *Time:* ${formatDateTime()}`;
                            
                            return await sock.sendMessage(from, { text: response }, { quoted: originalMsg });
                        }
                        
                        // Show article summary
                        let response = `📚 *Wikipedia*\n`;
                        response += `━━━━━━━━━━━━━━━━━━━━\n\n`;
                        response += `📖 *Title:* ${article.title}\n`;
                        response += `🌐 *Language:* ${langCode}\n\n`;
                        
                        // Truncate extract if too long
                        const maxLength = 1800;
                        let extract = article.extract;
                        if (extract.length > maxLength) {
                            extract = extract.substring(0, maxLength) + '...\n\n[වැඩිදුර කියවන්න Wikipedia එකේ]';
                        }
                        
                        response += `📝 *Summary:*\n${extract}\n\n`;
                        
                        // Show other search results if available
                        if (searchResults.length > 1) {
                            response += `🔍 *Other Results:*\n`;
                            searchResults.slice(1, 4).forEach((result, index) => {
                                response += `${index + 1}. ${result.title}\n`;
                            });
                            response += `\n`;
                        }
                        
                        response += `🔗 *Read More:* ${article.url}\n`;
                        response += `🕒 *Time:* ${formatDateTime()}`;
                        
                        return await sock.sendMessage(from, { text: response }, { quoted: originalMsg });
                        
                    } catch (error) {
                        console.error("Wikipedia search error:", error.message);
                        return await sock.sendMessage(from, { 
                            text: `❌ Wikipedia search failed!\n\nSearch: "${query}"\nLanguage: ${langCode}\n\nError: ${error.message}\n\nකරුණාකර නැවත උත්සාහ කරන්න.`
                        }, { quoted: originalMsg });
                    }
                }

                // --- Wikipedia Suggestions Command ---
                if (cmd === "wikisuggest" || cmd === "wsearch") {
                    if (!args[0]) {
                        return await sock.sendMessage(from, { 
                            text: `💡 *Wikipedia Suggestions*\n\nභාවිතා කරන විදිය:\n\`.wikisuggest <search term>\`\n\`.wsearch <search term>\`\n\nඋදාහරණ:\n\`.wikisuggest Sri Lanka\`\n\`.wsearch ලංකාව\``
                        }, { quoted: msg });
                    }
                    
                    const query = args.join(' ');
                    
                    await sock.sendMessage(from, { 
                        text: `💡 *Wikipedia Suggestions*\n\nSearch: "${query}"\n\n⏳ Searching suggestions...` 
                    }, { quoted: msg });
                    
                    try {
                        const suggestions = await getWikipediaSuggestions(query);
                        
                        if (!suggestions || suggestions.length === 0) {
                            return await sock.sendMessage(from, { 
                                text: `❌ No suggestions found!\n\nSearch: "${query}"\n\nTry a different search term.`
                            }, { quoted: msg });
                        }
                        
                        let response = `💡 *Wikipedia Search Suggestions*\n`;
                        response += `━━━━━━━━━━━━━━━━━━━━\n\n`;
                        response += `🔍 *Search:* "${query}"\n\n`;
                        response += `📋 *Suggestions:*\n`;
                        
                        suggestions.forEach((suggestion, index) => {
                            response += `${index + 1}. ${suggestion}\n`;
                        });
                        
                        response += `\n💡 *Tips:*\n`;
                        response += `• Use \`.wiki <suggestion>\` to read article\n`;
                        response += `• Try more specific terms\n`;
                        response += `• Check spelling\n`;
                        
                        response += `\n🕒 ${formatDateTime()}`;
                        
                        return await sock.sendMessage(from, { text: response }, { quoted: msg });
                        
                    } catch (error) {
                        console.error("Wiki suggestions error:", error.message);
                        return await sock.sendMessage(from, { 
                            text: `❌ Suggestions search failed!\n\nSearch: "${query}"\n\nError: ${error.message}`
                        }, { quoted: msg });
                    }
                }

                // Function to get Wikipedia search suggestions
                async function getWikipediaSuggestions(query, lang = 'en') {
                    try {
                        const encodedQuery = encodeURIComponent(query);
                        const url = `https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodedQuery}&limit=10&namespace=0&format=json`;
                        
                        const response = await fetch(url, {
                            headers: {
                                'User-Agent': 'WhatsAppBot/1.0',
                                'Accept': 'application/json'
                            }
                        });
                        
                        if (!response.ok) {
                            throw new Error(`API error: ${response.status}`);
                        }
                        
                        const data = await response.json();
                        return data[1] || []; // Return suggestions array
                        
                    } catch (error) {
                        console.log('Wikipedia suggestions error:', error.message);
                        return [];
                    }
                }

                // --- Wikipedia Today In History ---
                if (cmd === "wikiday" || cmd === "todayhistory") {
                    await sock.sendMessage(from, { 
                        text: `📅 *Today in History*\n\n⏳ Loading historical events...` 
                    }, { quoted: msg });
                    
                    try {
                        // Get today's date
                        const today = new Date();
                        const month = today.getMonth() + 1; // January is 0
                        const day = today.getDate();
                        
                        // Wikipedia page for today's date
                        let monthNames = [
                            "January", "February", "March", "April", "May", "June",
                            "July", "August", "September", "October", "November", "December"
                        ];
                        
                        const pageTitle = `${monthNames[month-1]} ${day}`;
                        const article = await getWikipediaSummary(pageTitle, 'si');
                        
                        if (!article) {
                            return await sock.sendMessage(from, { 
                                text: `❌ Could not load today's history.\n\nTry again later.`
                            }, { quoted: msg });
                        }
                        
                        let response = `📅 *Today in History*\n`;
                        response += `━━━━━━━━━━━━━━━━━━━━\n\n`;
                        response += `📆 *Date:* ${monthNames[month-1]} ${day}\n\n`;
                        
                        // Extract events from the summary
                        let extract = article.extract;
                        
                        // Try to find events section
                        const eventsMatch = extract.match(/(Events|Births|Deaths)[\s\S]*?(?=\n\n|\n[A-Z]|$)/i);
                        
                        if (eventsMatch) {
                            extract = eventsMatch[0];
                            
                            // Limit length
                            const maxLength = 1800;
                            if (extract.length > maxLength) {
                                extract = extract.substring(0, maxLength) + '...';
                            }
                            
                            response += `📜 *Historical Events:*\n${extract}\n\n`;
                        } else {
                            // Fallback to showing first part
                            const maxLength = 1800;
                            if (extract.length > maxLength) {
                                extract = extract.substring(0, maxLength) + '...';
                            }
                            response += `📝 *Information:*\n${extract}\n\n`;
                        }
                        
                        response += `🔗 *Read More:* ${article.url}\n`;
                        response += `🕒 ${formatDateTime()}`;
                        
                        return await sock.sendMessage(from, { text: response }, { quoted: msg });
                        
                    } catch (error) {
                        console.error("Today history error:", error.message);
                        return await sock.sendMessage(from, { 
                            text: `❌ Failed to load today's history.\n\nError: ${error.message}`
                        }, { quoted: msg });
                    }
                }

                // --- Wikipedia Image Search ---
                if (cmd === "wikiimage" || cmd === "wpimage") {
                    if (!args[0]) {
                        return await sock.sendMessage(from, { 
                            text: `🖼️ *Wikipedia Image Search*\n\nUsage:\n\`.wikiimage <search term>\`\n\`.wpimage <search term>\`\n\nExample:\n\`.wikiimage Sri Lanka\`\n\`.wikiimage ලංකාව\``
                        }, { quoted: msg });
                    }
                    
                    const query = args.join(' ');
                    
                    await sock.sendMessage(from, { 
                        text: `🖼️ *Wikipedia Image Search*\n\nSearch: "${query}"\n\n⏳ Searching images...` 
                    }, { quoted: msg });
                    
                    try {
                        // First get article
                        const searchResults = await searchWikipedia(query, 'si');
                        
                        if (!searchResults || searchResults.length === 0) {
                            return await sock.sendMessage(from, { 
                                text: `❌ No articles found for image search!\n\nSearch: "${query}"`
                            }, { quoted: msg });
                        }
                        
                        // Get first article
                        const firstResult = searchResults[0];
                        const imageUrl = await getWikipediaImage(firstResult.title);
                        
                        if (!imageUrl) {
                            // Fallback to article summary
                            const article = await getWikipediaSummary(firstResult.title, 'si');
                            
                            if (!article) {
                                return await sock.sendMessage(from, { 
                                    text: `❌ No image found!\n\nSearch: "${query}"\n\nTry a different search term.`
                                }, { quoted: msg });
                            }
                            
                            // Send article without image
                            let response = `📚 *Wikipedia*\n`;
                            response += `━━━━━━━━━━━━━━━━━━━━\n\n`;
                            response += `📖 *Title:* ${article.title}\n\n`;
                            
                            const maxLength = 1500;
                            let extract = article.extract;
                            if (extract.length > maxLength) {
                                extract = extract.substring(0, maxLength) + '...';
                            }
                            
                            response += `📝 *Summary:*\n${extract}\n\n`;
                            response += `🔗 *Read More:* ${article.url}\n`;
                            response += `🕒 ${formatDateTime()}`;
                            
                            return await sock.sendMessage(from, { text: response }, { quoted: msg });
                        }
                        
                        // Send image with caption
                        return await sock.sendMessage(from, {
                            image: { url: imageUrl },
                            caption: `📷 *Wikipedia Image*\n\nTitle: ${firstResult.title}\nSearch: "${query}"\n\n🕒 ${formatDateTime()}`
                        }, { quoted: msg });
                        
                    } catch (error) {
                        console.error("Wiki image error:", error.message);
                        return await sock.sendMessage(from, { 
                            text: `❌ Image search failed!\n\nSearch: "${query}"\n\nError: ${error.message}`
                        }, { quoted: msg });
                    }
                }

                // Function to get Wikipedia image
                async function getWikipediaImage(title, lang = 'si') {
                    try {
                        const encodedTitle = encodeURIComponent(title);
                        const url = `https://${lang}.wikipedia.org/w/api.php?action=query&titles=${encodedTitle}&prop=pageimages&format=json&pithumbsize=500`;
                        
                        const response = await fetch(url, {
                            headers: {
                                'User-Agent': 'WhatsAppBot/1.0',
                                'Accept': 'application/json'
                            }
                        });
                        
                        if (!response.ok) {
                            throw new Error(`API error: ${response.status}`);
                        }
                        
                        const data = await response.json();
                        const pages = data.query?.pages;
                        
                        if (!pages) return null;
                        
                        const pageId = Object.keys(pages)[0];
                        const page = pages[pageId];
                        
                        if (page.thumbnail && page.thumbnail.source) {
                            return page.thumbnail.source;
                        }
                        
                        return null;
                        
                    } catch (error) {
                        console.log('Wikipedia image error:', error.message);
                        return null;
                    }
                }

                // --- QUOTE COMMAND (DNS Auto Retry + Google Translate) ---
                if (cmd === "quote") {
                    try {

                        async function translateText(text, targetLang = "si") {
                            try {
                                const url =
                                    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" +
                                    targetLang +
                                    "&dt=t&q=" +
                                    encodeURIComponent(text);

                                const res = await fetch(url);
                                const data = await res.json();
                                return data[0].map((x) => x[0]).join("") || text;
                            } catch (e) {
                                return text;
                            }
                        }

                        // QUOTE APIs
                        const apis = [
                            {
                                url: "https://api.quotable.io/random",
                                parser: (d) => ({ quote: d.content, author: d.author }),
                            },
                            {
                                url: "https://zenquotes.io/api/random",
                                parser: (d) => ({ quote: d[0].q, author: d[0].a }),
                            },
                            {
                                url: "https://api.goprogram.ai/inspiration",
                                parser: (d) => ({ quote: d.quote, author: d.author }),
                            },
                        ];

                        let enQuote = null;
                        let enAuthor = null;

                        // TRY EACH API UNTIL WE GET ONE SUCCESS
                        for (let api of apis) {
                            try {
                                const r = await fetch(api.url, { timeout: 5000 });
                                if (!r.ok) continue;

                                const d = await r.json();
                                const parsed = api.parser(d);

                                if (parsed.quote) {
                                    enQuote = parsed.quote;
                                    enAuthor = parsed.author || "Unknown";
                                    break;
                                }
                            } catch (err) {
                                continue;
                            }
                        }

                        // If ALL FAIL → fallback
                        if (!enQuote) {
                            const fallback = [
                                "ඔයා කිරීමට බියවන දේවල් තමයි ඔයා වර්ධනය කරන්නේ.",
                                "එදිනෙදා ලොකු වෙනවා කියන්නේ පොඩි දේවල් පැහැදිලිව කරන එක.",
                                "ඔයාගේ තීරණයි ඔයාගේ ජීවිතය හැදෙන්නේ."
                            ];

                            const pick = fallback[Math.floor(Math.random() * fallback.length)];

                            return await sock.sendMessage(
                                from,
                                { text: `⚠️ Quote API Error!\n\n> ${pick}` },
                                { quoted: msg }
                            );
                        }

                        // Translate
                        const siQuote = await translateText(enQuote);
                        const siAuthor =
                            enAuthor === "Unknown" ? "නොදන්නා" : await translateText(enAuthor);

                        const finalMsg = `
🌟 *ඔබට දිරිගන්වන වදනක්* 🌟
━━━━━━━━━━━━━━━━━━━━
> "${siQuote}"
~ _${siAuthor}_
━━━━━━━━━━━━━━━━━━━━
                `;

                        return await sock.sendMessage(from, { text: finalMsg }, { quoted: msg });

                    } catch (e) {
                        return await sock.sendMessage(
                            from,
                            { text: "❌ Unexpected Error!" },
                            { quoted: msg }
                        );
                    }
                }



                


            }
        } catch (error) {
            console.error("Error in message handler:", error.message);
        }
    });
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error.message);
    console.error('Stack:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the bot
startBot().catch(error => {
    console.error("Failed to start bot:", error);
    console.log("Restarting in 10 seconds...");
    setTimeout(startBot, 10000);
});