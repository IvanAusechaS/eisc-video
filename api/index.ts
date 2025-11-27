import { Server, Socket } from "socket.io";
import { ExpressPeerServer } from "peer";
import express from "express";
import cors from "cors";
import http from "http";
import "dotenv/config";

/**
 * 🚀 WebRTC Signaling Server - Heroku Production Ready
 * 
 * Deployed at: https://eisc-video-3ee1ac20d78b.herokuapp.com
 * 
 * Features:
 * ✅ Single unified Express + Socket.IO + PeerJS server
 * ✅ Heroku-safe CORS configuration
 * ✅ Polling + WebSocket transport (Heroku router requires polling)
 * ✅ allowEIO3: true for Heroku compatibility
 * ✅ PeerJS with proxied: true for Heroku reverse proxy
 * ✅ Timeouts disabled for persistent WebRTC connections
 * ✅ Detailed logging for debugging
 * ✅ Room management (max 2 users)
 * ✅ Duplicate remotePeerId prevention
 * ✅ Media toggle events support
 */

// ============ TYPES ============
interface RoomData {
  users: Set<string>;
  peerIds: Map<string, string>; // socketId -> peerId
  peerIdsSent: Map<string, Set<string>>; // socketId -> Set<otherSocketIds> que ya recibieron su peerId
}

// ============ CONFIGURATION ============
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = "https://eisc-video-3ee1ac20d78b.herokuapp.com";
const MAX_USERS_PER_ROOM = 2;
const DEFAULT_ROOM = "main-room";

// ============ STORAGE ============
const rooms = new Map<string, RoomData>();

// ============ EXPRESS APP ============
const app = express();

// ✅ CORS - Allow all origins (Heroku proxy rewrites headers)
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  credentials: true
}));

app.use(express.json());

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
const server = http.createServer(app);

// ✅ Disable timeouts so Heroku doesn't kill WebRTC connections
server.keepAliveTimeout = 0;
server.headersTimeout = 0;

// ============ SOCKET.IO SERVER ============
// ✅ Heroku-safe Socket.IO configuration (MUST allow polling)
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ["polling", "websocket"], // polling MUST be first for Heroku router
  allowEIO3: true, // critical for Heroku router compatibility
  pingTimeout: 30000,
  pingInterval: 25000
});

// ============ PEERJS SERVER ============
// ✅ Mount PeerJS at /peerjs with Heroku proxy support
// CRITICAL: When using app.use("/peerjs", ...), the path parameter must be "/"
const peerServer = ExpressPeerServer(server, {
  path: "/",
  debug: true,
  proxied: true, // required for Heroku reverse proxy
  allow_discovery: true
} as any);

app.use("/peerjs", peerServer);

// PeerJS event listeners with detailed logging
peerServer.on("connection", (client: any) => {
  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] [PEERJS_CONNECT] ✅ Client connected: ${client.getId()}`);
});

peerServer.on("disconnect", (client: any) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [PEERJS_DISCONNECT] ❌ Client disconnected: ${client.getId()}`);
});

// ============ UTILITIES ============
const truncate = (str: string, len = 8): string => str.substring(0, len);

const log = (type: string, message: string, data?: Record<string, any>) => {
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
const getOrCreateRoom = (roomId: string): RoomData => {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      users: new Set(),
      peerIds: new Map(),
      peerIdsSent: new Map(),
    });
    log("ROOM_CREATE", `Room ${roomId} created`);
  }
  return rooms.get(roomId)!;
};

const deleteRoomIfEmpty = (roomId: string): void => {
  const room = rooms.get(roomId);
  if (room && room.users.size === 0) {
    rooms.delete(roomId);
    log("ROOM_DELETE", `Room ${roomId} deleted (empty)`);
  }
};

const getRoomUserCount = (roomId: string): number => {
  const room = rooms.get(roomId);
  return room ? room.users.size : 0;
};

// ============ PEER ID EXCHANGE ============
const exchangePeerIds = (socket: Socket, roomId: string, myPeerId: string): void => {
  const room = rooms.get(roomId);
  if (!room) return;

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
      room.peerIdsSent.get(mySocketId)!.add(otherSocketId);
      
      log("PEER_SENT", `Sent my Peer ID to ${truncate(otherSocketId)}`, {
        from: truncate(mySocketId),
        to: truncate(otherSocketId),
        peerId: truncate(myPeerId),
      });
    } else {
      log("PEER_SKIP_DUPLICATE", `Already sent my Peer ID to ${truncate(otherSocketId)}`);
    }

    // Enviar el Peer ID del otro usuario a mí (si aún no lo recibí)
    if (!alreadyReceivedFromOther) {
      socket.emit("remotePeerId", otherPeerId);
      
      // Marcar que recibimos el Peer ID del otro
      if (!mySentSet) {
        room.peerIdsSent.set(mySocketId, new Set());
      }
      room.peerIdsSent.get(mySocketId)!.add(otherSocketId);
      
      log("PEER_SENT", `Sent other Peer ID to ${truncate(mySocketId)}`, {
        from: truncate(otherSocketId),
        to: truncate(mySocketId),
        peerId: truncate(otherPeerId),
      });
    } else {
      log("PEER_SKIP_DUPLICATE", `Already received Peer ID from ${truncate(otherSocketId)}`);
    }
  });

  log("PEER_EXCHANGE_COMPLETE", `Exchange complete for ${truncate(mySocketId)}`);
};

// ============ JOIN ROOM ============
const joinRoom = (socket: Socket, roomId: string): boolean => {
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
const registerPeerId = (socket: Socket, roomId: string, peerId: string): void => {
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
const handleDisconnect = (socket: Socket, roomId: string): void => {
  const room = rooms.get(roomId);
  if (!room) return;

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
const handleMediaToggle = (
  socket: Socket,
  roomId: string,
  data: { type: "audio" | "video"; enabled: boolean; peerId: string }
): void => {
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
io.on("connection", (socket: Socket) => {
  const roomId = DEFAULT_ROOM;

  log("SOCKET_CONNECT", `New Socket.IO connection`, {
    socketId: truncate(socket.id),
    transport: socket.conn.transport.name,
    clientIP: socket.handshake.address,
  });

  // Intentar unirse a la sala
  const joined = joinRoom(socket, roomId);
  if (!joined) {
    return; // Usuario rechazado, socket ya desconectado
  }

  // ============ REGISTER PEER ID ============
  socket.on("registerPeerId", (peerId: string) => {
    log("EVENT_REGISTER", `Received registerPeerId event`, {
      socketId: truncate(socket.id),
      peerId: truncate(peerId),
    });
    registerPeerId(socket, roomId, peerId);
  });

  // ============ MEDIA TOGGLE ============
  socket.on("mediaToggle", (data: { type: "audio" | "video"; enabled: boolean; peerId: string }) => {
    log("EVENT_MEDIA", `Received mediaToggle event`, {
      socketId: truncate(socket.id),
      type: data.type,
      enabled: data.enabled,
    });
    handleMediaToggle(socket, roomId, data);
  });

  // ============ DISCONNECT ============
  socket.on("disconnect", (reason: string) => {
    log("SOCKET_DISCONNECT", `Socket.IO disconnected`, {
      socketId: truncate(socket.id),
      reason,
    });
    handleDisconnect(socket, roomId);
  });
});

// ============ ERROR HANDLING ============
io.engine.on("connection_error", (err: any) => {
  console.error(`[CONNECTION_ERROR] ${err.message}`);
  console.error(`  Code: ${err.code}`);
  console.error(`  Context: ${err.context}`);
});

// ============ GRACEFUL SHUTDOWN ============
const shutdown = (signal: string) => {
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
process.on("uncaughtException", (error: Error) => {
  console.error("❌ UNCAUGHT EXCEPTION:", error);
  shutdown("UNCAUGHT_EXCEPTION");
});

process.on("unhandledRejection", (reason: any) => {
  console.error("❌ UNHANDLED REJECTION:", reason);
  shutdown("UNHANDLED_REJECTION");
});