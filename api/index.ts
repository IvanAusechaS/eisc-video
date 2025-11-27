import { Server, Socket } from "socket.io";
import "dotenv/config";

/**
 * WebRTC Signaling Server - Optimizado para PeerJS
 * 
 * Funcionalidad:
 * - Rooms de máximo 2 usuarios
 * - Intercambio de Peer IDs sin duplicados
 * - Sin manejo de ICE/SDP (PeerJS lo hace)
 * - Limpieza total en disconnect
 * - Logs detallados
 * 
 * Compatible con frontend React + PeerJS + Socket.IO
 */

// ============ TYPES ============
interface RoomData {
  users: Set<string>;
  peerIds: Map<string, string>; // socketId -> peerId
  peerIdsSent: Map<string, Set<string>>; // socketId -> Set<otherSocketIds> que ya recibieron su peerId
}

// ============ CONFIGURATION ============
const port = Number(process.env.PORT) || 3001;
const MAX_USERS_PER_ROOM = 2;
const DEFAULT_ROOM = "main-room";

// ============ STORAGE ============
const rooms = new Map<string, RoomData>();

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

// ============ SERVER INITIALIZATION ============
const io = new Server({
  cors: {
    origin: "*", // TODO: En producción, especificar dominios permitidos
  },
});

io.listen(port);

console.log("=".repeat(60));
console.log(`🚀 WebRTC Signaling Server`);
console.log("=".repeat(60));
console.log(`📡 Port: ${port}`);
console.log(`🌐 CORS: Enabled for all origins (dev mode)`);
console.log(`👥 Max users per room: ${MAX_USERS_PER_ROOM}`);
console.log(`🏠 Default room: ${DEFAULT_ROOM}`);
console.log(`⚡ PeerJS compatible (no ICE/SDP signaling)`);
console.log("=".repeat(60));

// ============ SOCKET HANDLERS ============
io.on("connection", (socket: Socket) => {
  const roomId = DEFAULT_ROOM;

  log("CONNECT", `New connection`, {
    socketId: truncate(socket.id),
    transport: socket.conn.transport.name,
  });

  // Intentar unirse a la sala
  const joined = joinRoom(socket, roomId);
  if (!joined) {
    return; // Usuario rechazado, socket ya desconectado
  }

  // ============ REGISTER PEER ID ============
  socket.on("registerPeerId", (peerId: string) => {
    registerPeerId(socket, roomId, peerId);
  });

  // ============ MEDIA TOGGLE ============
  socket.on("mediaToggle", (data: { type: "audio" | "video"; enabled: boolean; peerId: string }) => {
    handleMediaToggle(socket, roomId, data);
  });

  // ============ DISCONNECT ============
  socket.on("disconnect", () => {
    handleDisconnect(socket, roomId);
  });
});

// ============ GRACEFUL SHUTDOWN ============
process.on("SIGTERM", () => {
  console.log("\n🛑 SIGTERM received, closing server...");
  io.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("\n🛑 SIGINT received, closing server...");
  io.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });
});