"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const socket_io_1 = require("socket.io");
const peer_1 = require("peer");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const http_1 = __importDefault(require("http"));
require("dotenv/config");
// ============ CONFIGURATION ============
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = "https://eisc-video-3ee1ac20d78b.herokuapp.com";
const MAX_USERS_PER_ROOM = 2;
const DEFAULT_ROOM = "main-room";
// ============ STORAGE ============
const rooms = new Map();
// ============ EXPRESS APP ============
const app = (0, express_1.default)();
// FIX HEROKU: Trust proxy headers (required for Heroku routing)
app.set("trust proxy", 1);
// FIX HEROKU: CORS must be specific for Vercel origin
app.use((0, cors_1.default)({
    origin: ["https://eisc-meet.vercel.app", "http://localhost:5173", "http://localhost:3000"],
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"]
}));
// FIX HEROKU: JSON parser AFTER Socket.IO to avoid consuming polling frames
// We'll move this AFTER Socket.IO initialization
// Health check endpoint for Heroku
app.get("/", (req, res) => {
    res.json({
        status: "online",
        service: "EISC Video Signaling Server",
        url: PUBLIC_URL,
        endpoints: {
            peerjs: `${PUBLIC_URL}/peerjs`,
            socketio: PUBLIC_URL,
            health: `${PUBLIC_URL}/health`
        },
        rooms: rooms.size,
        timestamp: new Date().toISOString()
    });
});
app.get("/health", (req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
});
// ============ HTTP SERVER ============
const server = http_1.default.createServer(app);
// FIX HEROKU: Disable aggressive timeouts that kill WebRTC
server.keepAliveTimeout = 0;
server.headersTimeout = 0;
// ============ SOCKET.IO SERVER ============
// FIX HEROKU: Critical configuration for Heroku router compatibility
const io = new socket_io_1.Server(server, {
    cors: {
        origin: ["https://eisc-meet.vercel.app", "http://localhost:5173"],
        methods: ["GET", "POST", "OPTIONS"],
        credentials: true
    },
    // FIX HEROKU: Polling MUST be first, WebSocket is upgrade
    transports: ["polling", "websocket"],
    // FIX HEROKU: Allow Engine.IO v3 clients (Heroku router uses EIO3 internally)
    allowEIO3: true,
    // FIX HEROKU: Disable perMessageDeflate (Heroku doesn't support WS compression)
    perMessageDeflate: false,
    // FIX HEROKU: Increase timeouts for slow connections
    pingTimeout: 60000,
    pingInterval: 25000,
    // FIX HEROKU: Allow upgrade from polling to WebSocket
    upgradeTimeout: 30000,
    // FIX HEROKU: Set max HTTP buffer size for polling frames
    maxHttpBufferSize: 1e6,
    // FIX HEROKU: Cookie configuration for Heroku proxy
    cookie: {
        name: "io",
        path: "/",
        httpOnly: true,
        sameSite: "none",
        secure: true
    }
});
// FIX HEROKU: Now it's safe to use JSON parser (after Socket.IO)
app.use(express_1.default.json());
// ============ PEERJS SERVER ============
// FIX HEROKU: PeerJS configuration for Heroku reverse proxy
// CRITICAL: When using app.use("/peerjs", ...), the path parameter must be "/"
const peerServer = (0, peer_1.ExpressPeerServer)(server, {
    path: "/",
    debug: true,
    // FIX HEROKU: Enable proxied mode (Heroku router is a reverse proxy)
    proxied: true,
    // FIX HEROKU: Allow peer discovery
    allow_discovery: true,
    // FIX HEROKU: Increase timeouts for Heroku latency
    alive_timeout: 60000,
    // FIX HEROKU: Key for generating peer IDs
    key: "peerjs",
    // FIX HEROKU: Concurrent limit (2 users max per room)
    concurrent_limit: 5000
});
app.use("/peerjs", peerServer);
// PeerJS event listeners with detailed logging
peerServer.on("connection", (client) => {
    const timestamp = new Date().toISOString();
    console.log(`\n[${timestamp}] [PEERJS_CONNECT] ✅ Client connected: ${client.getId()}`);
});
peerServer.on("disconnect", (client) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [PEERJS_DISCONNECT] ❌ Client disconnected: ${client.getId()}`);
});
// ============ UTILITIES ============
const truncate = (str, len = 8) => str.substring(0, len);
const log = (type, message, data) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${type}] ${message}`);
    if (data) {
        Object.entries(data).forEach(([key, value]) => {
            console.log(`  ${key}: ${value}`);
        });
    }
};
// ============ STATUS MONITORING ============
setInterval(() => {
    const activeConnections = io.engine.clientsCount;
    console.log(`\n[STATUS] Active Socket.IO connections: ${activeConnections}`);
    console.log(`[STATUS] Active rooms: ${rooms.size}`);
    rooms.forEach((room, roomId) => {
        console.log(`  - Room ${roomId}: ${room.users.size}/${MAX_USERS_PER_ROOM} users`);
    });
    const totalPeerIds = Array.from(rooms.values()).reduce((sum, room) => sum + room.peerIds.size, 0);
    console.log(`[STATUS] Total peer IDs registered: ${totalPeerIds}`);
}, 30000);
// ============ ROOM MANAGEMENT ============
const getOrCreateRoom = (roomId) => {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, {
            users: new Set(),
            peerIds: new Map(),
            peerIdsSent: new Map(),
        });
        log("ROOM_CREATE", `Room ${roomId} created`);
    }
    return rooms.get(roomId);
};
const deleteRoomIfEmpty = (roomId) => {
    const room = rooms.get(roomId);
    if (room && room.users.size === 0) {
        rooms.delete(roomId);
        log("ROOM_DELETE", `Room ${roomId} deleted (empty)`);
    }
};
const getRoomUserCount = (roomId) => {
    const room = rooms.get(roomId);
    return room ? room.users.size : 0;
};
// ============ PEER ID EXCHANGE ============
const exchangePeerIds = (socket, roomId, myPeerId) => {
    const room = rooms.get(roomId);
    if (!room)
        return;
    const mySocketId = socket.id;
    log("PEER_EXCHANGE_START", `Exchanging Peer IDs for ${truncate(mySocketId)}`, {
        myPeerId: truncate(myPeerId),
        roomId,
        roomUsers: room.users.size,
    });
    // Inicializar tracking si no existe
    if (!room.peerIdsSent.has(mySocketId)) {
        room.peerIdsSent.set(mySocketId, new Set());
    }
    // Encontrar otros usuarios en la sala
    const otherUsers = Array.from(room.users).filter((id) => id !== mySocketId);
    if (otherUsers.length === 0) {
        log("PEER_WAITING", `${truncate(mySocketId)} is alone, waiting for peer`);
        return;
    }
    // Para cada otro usuario
    otherUsers.forEach((otherSocketId) => {
        const otherPeerId = room.peerIds.get(otherSocketId);
        if (!otherPeerId) {
            log("PEER_SKIP", `Other user ${truncate(otherSocketId)} hasn't registered Peer ID yet`);
            return;
        }
        // Verificar si ya enviamos nuestro Peer ID al otro usuario
        const otherSentSet = room.peerIdsSent.get(otherSocketId);
        const alreadySentToOther = otherSentSet && otherSentSet.has(mySocketId);
        // Verificar si ya recibimos el Peer ID del otro usuario
        const mySentSet = room.peerIdsSent.get(mySocketId);
        const alreadyReceivedFromOther = mySentSet && mySentSet.has(otherSocketId);
        // Enviar mi Peer ID al otro usuario (si aún no lo hicimos)
        if (!alreadySentToOther) {
            socket.to(otherSocketId).emit("remotePeerId", myPeerId);
            // Marcar que enviamos nuestro Peer ID al otro
            if (!room.peerIdsSent.has(mySocketId)) {
                room.peerIdsSent.set(mySocketId, new Set());
            }
            room.peerIdsSent.get(mySocketId).add(otherSocketId);
            log("PEER_SENT", `Sent my Peer ID to ${truncate(otherSocketId)}`, {
                from: truncate(mySocketId),
                to: truncate(otherSocketId),
                peerId: truncate(myPeerId),
            });
        }
        else {
            log("PEER_SKIP_DUPLICATE", `Already sent my Peer ID to ${truncate(otherSocketId)}`);
        }
        // Enviar el Peer ID del otro usuario a mí (si aún no lo recibí)
        if (!alreadyReceivedFromOther) {
            socket.emit("remotePeerId", otherPeerId);
            // Marcar que recibimos el Peer ID del otro
            if (!mySentSet) {
                room.peerIdsSent.set(mySocketId, new Set());
            }
            room.peerIdsSent.get(mySocketId).add(otherSocketId);
            log("PEER_SENT", `Sent other Peer ID to ${truncate(mySocketId)}`, {
                from: truncate(otherSocketId),
                to: truncate(mySocketId),
                peerId: truncate(otherPeerId),
            });
        }
        else {
            log("PEER_SKIP_DUPLICATE", `Already received Peer ID from ${truncate(otherSocketId)}`);
        }
    });
    log("PEER_EXCHANGE_COMPLETE", `Exchange complete for ${truncate(mySocketId)}`);
};
// ============ JOIN ROOM ============
const joinRoom = (socket, roomId) => {
    const room = getOrCreateRoom(roomId);
    const currentCount = room.users.size;
    // Verificar si la sala está llena
    if (currentCount >= MAX_USERS_PER_ROOM) {
        log("ROOM_FULL", `User ${truncate(socket.id)} rejected`, {
            roomId,
            currentUsers: currentCount,
            maxUsers: MAX_USERS_PER_ROOM,
        });
        socket.emit("roomFull", {
            message: "Room is full. Only 2 users allowed.",
        });
        socket.disconnect(true);
        return false;
    }
    // Agregar usuario a la sala
    room.users.add(socket.id);
    socket.join(roomId);
    log("USER_JOIN", `User ${truncate(socket.id)} joined room`, {
        roomId,
        users: `${room.users.size}/${MAX_USERS_PER_ROOM}`,
    });
    // Notificar a todos el conteo actualizado
    socket.to(roomId).emit("userCount", room.users.size);
    socket.emit("userCount", room.users.size);
    return true;
};
// ============ REGISTER PEER ID ============
const registerPeerId = (socket, roomId, peerId) => {
    const room = rooms.get(roomId);
    if (!room) {
        log("PEER_ERROR", `Room ${roomId} not found for ${truncate(socket.id)}`);
        return;
    }
    // Guardar Peer ID
    room.peerIds.set(socket.id, peerId);
    log("PEER_REGISTER", `User registered Peer ID`, {
        socketId: truncate(socket.id),
        peerId: truncate(peerId),
        roomId,
    });
    // Intercambiar Peer IDs con otros usuarios
    exchangePeerIds(socket, roomId, peerId);
};
// ============ HANDLE DISCONNECT ============
const handleDisconnect = (socket, roomId) => {
    const room = rooms.get(roomId);
    if (!room)
        return;
    const socketId = socket.id;
    const peerId = room.peerIds.get(socketId);
    log("USER_DISCONNECT", `User disconnecting`, {
        socketId: truncate(socketId),
        peerId: peerId ? truncate(peerId) : "none",
        roomId,
        remainingUsers: room.users.size - 1,
    });
    // Limpiar usuario de la sala
    room.users.delete(socketId);
    room.peerIds.delete(socketId);
    room.peerIdsSent.delete(socketId);
    // Limpiar referencias en otros usuarios
    room.peerIdsSent.forEach((sentSet) => {
        sentSet.delete(socketId);
    });
    // Notificar a otros usuarios
    socket.to(roomId).emit("userDisconnected", socketId);
    socket.to(roomId).emit("userCount", room.users.size);
    // Eliminar sala si quedó vacía
    deleteRoomIfEmpty(roomId);
};
// ============ MEDIA TOGGLE ============
const handleMediaToggle = (socket, roomId, data) => {
    log("MEDIA_TOGGLE", `User toggled media`, {
        socketId: truncate(socket.id),
        type: data.type,
        enabled: data.enabled,
        peerId: truncate(data.peerId),
    });
    // Reenviar a otros usuarios en la sala
    socket.to(roomId).emit("mediaToggle", data);
};
// ============ SERVER START ============
// ✅ Listen on Heroku-provided port, bind to 0.0.0.0
server.listen(PORT, "0.0.0.0", () => {
    console.log("=".repeat(70));
    console.log(`🚀 EISC Video Signaling Server - HEROKU PRODUCTION`);
    console.log("=".repeat(70));
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌐 Public URL: ${PUBLIC_URL}`);
    console.log(`🔌 Socket.IO: wss://${PUBLIC_URL.replace('https://', '')}`);
    console.log(`📹 PeerJS: ${PUBLIC_URL}/peerjs (proxied: true)`);
    console.log(`❤️ Health: ${PUBLIC_URL}/health`);
    console.log(`🌍 CORS: Enabled for all origins`);
    console.log(`👥 Max users per room: ${MAX_USERS_PER_ROOM}`);
    console.log(`⚡ Transports: [polling, websocket] (Heroku-safe)`);
    console.log(`🔧 Keep-alive timeout: Disabled`);
    console.log(`📊 Status monitoring: Every 30s`);
    console.log("=".repeat(70));
    console.log(`✅ Server ready for WebRTC connections!`);
    console.log("=".repeat(70));
});
// ============ SOCKET.IO EVENT HANDLERS ============
io.on("connection", (socket) => {
    const roomId = DEFAULT_ROOM;
    log("SOCKET_CONNECT", `New Socket.IO connection`, {
        socketId: truncate(socket.id),
        transport: socket.conn.transport.name,
        clientIP: socket.handshake.address,
    });
    // FIX HEROKU: Log transport upgrades
    socket.conn.on("upgrade", (transport) => {
        log("TRANSPORT_UPGRADE", `Transport upgraded`, {
            socketId: truncate(socket.id),
            from: socket.conn.transport.name,
            to: transport.name
        });
    });
    // FIX HEROKU: Log packet errors
    socket.conn.on("packet", (packet) => {
        if (packet.type === "error") {
            log("PACKET_ERROR", `Packet error`, {
                socketId: truncate(socket.id),
                data: packet.data
            });
        }
    });
    // Intentar unirse a la sala
    const joined = joinRoom(socket, roomId);
    if (!joined) {
        return; // Usuario rechazado, socket ya desconectado
    }
    // ============ REGISTER PEER ID ============
    socket.on("registerPeerId", (peerId) => {
        log("EVENT_REGISTER", `Received registerPeerId event`, {
            socketId: truncate(socket.id),
            peerId: truncate(peerId),
        });
        registerPeerId(socket, roomId, peerId);
    });
    // ============ MEDIA TOGGLE ============
    socket.on("mediaToggle", (data) => {
        log("EVENT_MEDIA", `Received mediaToggle event`, {
            socketId: truncate(socket.id),
            type: data.type,
            enabled: data.enabled,
        });
        handleMediaToggle(socket, roomId, data);
    });
    // ============ DISCONNECT ============
    socket.on("disconnect", (reason) => {
        log("SOCKET_DISCONNECT", `Socket.IO disconnected`, {
            socketId: truncate(socket.id),
            reason,
        });
        handleDisconnect(socket, roomId);
    });
});
// ============ ERROR HANDLING ============
// FIX HEROKU: Enhanced error handling for debugging
io.engine.on("connection_error", (err) => {
    console.error(`[CONNECTION_ERROR] ${err.message}`);
    console.error(`  Code: ${err.code}`);
    console.error(`  Context: ${err.context}`);
    if (err.req) {
        console.error(`  Method: ${err.req.method}`);
        console.error(`  URL: ${err.req.url}`);
        console.error(`  Headers:`, err.req.headers);
    }
});
// FIX HEROKU: Log initial handshake errors
io.engine.on("initial_headers", (headers, req) => {
    console.log(`[HANDSHAKE] Initial headers for ${req.url}`);
});
// FIX HEROKU: Log all connections to engine
io.engine.on("connection", (rawSocket) => {
    console.log(`[ENGINE_CONNECT] Raw connection established, transport: ${rawSocket.transport.name}`);
});
// ============ GRACEFUL SHUTDOWN ============
const shutdown = (signal) => {
    console.log(`\n🛑 ${signal} received, gracefully shutting down...`);
    // Close all Socket.IO connections
    io.close(() => {
        console.log("✅ Socket.IO closed");
    });
    // Close HTTP server
    server.close(() => {
        console.log("✅ HTTP Server closed");
        console.log("👋 Server shutdown complete");
        process.exit(0);
    });
    // Force close after 10 seconds
    setTimeout(() => {
        console.error("⚠️ Forced shutdown after timeout");
        process.exit(1);
    }, 10000);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
// Handle uncaught errors
process.on("uncaughtException", (error) => {
    console.error("❌ UNCAUGHT EXCEPTION:", error);
    shutdown("UNCAUGHT_EXCEPTION");
});
process.on("unhandledRejection", (reason) => {
    console.error("❌ UNHANDLED REJECTION:", reason);
    shutdown("UNHANDLED_REJECTION");
});
