import { Server} from "socket.io";
import "dotenv/config";

const origins = (process.env.ORIGIN ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const io = new Server({
  cors: {
    origin: "*" // Permitir todos los orígenes para desarrollo local
  }
});

const port = Number(process.env.PORT) || 3001; // Puerto 3001 por defecto

io.listen(port);
console.log(`=`.repeat(50));
console.log(`[SERVER] WebRTC Signaling server running on port ${port}`);
console.log(`[CORS] Enabled for all origins`);
console.log(`[MODE] Multiple rooms - 2 users per room`);
console.log(`[ENV] NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
console.log(`[ENV] PORT: ${port}`);
console.log(`=`.repeat(50));

let rooms: Record<string, Set<string>> = {};
let peerIds: Record<string, string> = {}; // Mapear socketId -> peerId
const MAX_PEERS_PER_ROOM = 2;
const DEFAULT_ROOM = "main-room";

// Log estado cada 30 segundos
setInterval(() => {
  console.log(`[STATUS] Active rooms: ${Object.keys(rooms).length}`);
  Object.keys(rooms).forEach(roomId => {
    console.log(`  - Room ${roomId}: ${rooms[roomId].size} users`);
  });
  console.log(`[STATUS] Total peer IDs registered: ${Object.keys(peerIds).length}`);
}, 30000);

io.on("connection", (socket) => {
  const roomId = DEFAULT_ROOM;
  const timestamp = new Date().toISOString();
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${timestamp}] NEW CONNECTION`);
  console.log(`  Socket ID: ${socket.id}`);
  console.log(`  Client IP: ${socket.handshake.address}`);
  console.log(`  User Agent: ${socket.handshake.headers['user-agent']?.substring(0, 50)}...`);
  
  // Inicializar sala si no existe
  if (!rooms[roomId]) {
    rooms[roomId] = new Set();
    console.log(`  Created new room: ${roomId}`);
  }
  
  const currentPeerCount = rooms[roomId].size;
  console.log(`  Current peers in room: ${currentPeerCount}/${MAX_PEERS_PER_ROOM}`);
  
  // Limitar a 2 usuarios por sala
  if (currentPeerCount >= MAX_PEERS_PER_ROOM) {
    console.log(`  ❌ REJECTED - Room ${roomId} is FULL (${currentPeerCount}/${MAX_PEERS_PER_ROOM})`);
    socket.emit("roomFull", { message: "Room is full. Only 2 users allowed." });
    socket.disconnect(true);
    console.log(`${'='.repeat(60)}\n`);
    return;
  }

  // Agregar usuario a la sala
  rooms[roomId].add(socket.id);
  socket.join(roomId);
  
  console.log(`  ✅ ACCEPTED - User joined room ${roomId}`);
  console.log(`  New peer count: ${rooms[roomId].size}/${MAX_PEERS_PER_ROOM}`);
  console.log(`${'='.repeat(60)}\n`);

  // Notificar a todos en la sala el número de usuarios (incluyendo al que acaba de conectarse)
  io.to(roomId).emit("userCount", rooms[roomId].size);
  
  // También enviar directamente al socket que se conectó para asegurar que recibe el conteo
  socket.emit("userCount", rooms[roomId].size);
  
  console.log(`[USER_COUNT] Broadcasted to room ${roomId}: ${rooms[roomId].size} users`);

  // Cuando un usuario registra su Peer ID
  socket.on("registerPeerId", (peerId: string) => {
    peerIds[socket.id] = peerId;
    const timestamp = new Date().toISOString();
    
    console.log(`\n[${timestamp}] PEER_ID_REGISTERED`);
    console.log(`  Socket: ${socket.id.substring(0, 8)}...`);
    console.log(`  Peer ID: ${peerId.substring(0, 16)}...`);
    
    // Informar a otros usuarios en la sala del nuevo Peer ID
    const otherPeersInRoom = Array.from(rooms[roomId]).filter(id => id !== socket.id);
    console.log(`  Other peers in room: ${otherPeersInRoom.length}`);
    
    if (otherPeersInRoom.length > 0) {
      otherPeersInRoom.forEach(otherId => {
        const otherPeerId = peerIds[otherId];
        if (otherPeerId) {
          // Enviar al nuevo usuario el Peer ID del usuario existente
          socket.emit("remotePeerId", otherPeerId);
          console.log(`  📤 Sent to new peer (${peerId.substring(0, 8)}...): remote peer ID ${otherPeerId.substring(0, 8)}...`);
          
          // Enviar al usuario existente el Peer ID del nuevo usuario
          io.to(otherId).emit("remotePeerId", peerId);
          console.log(`  📤 Sent to existing peer (${otherPeerId.substring(0, 8)}...): remote peer ID ${peerId.substring(0, 8)}...`);
          
          console.log(`  ✅ PEER EXCHANGE COMPLETE between ${peerId.substring(0, 8)}... and ${otherPeerId.substring(0, 8)}...`);
        } else {
          console.log(`  ⚠️ Other peer ${otherId.substring(0, 8)}... has no registered Peer ID yet`);
        }
      });
    } else {
      console.log(`  ⏳ WAITING - ${peerId.substring(0, 8)}... is the only peer in the room`);
    }
  });

  socket.on("signal", (to, from, data) => {
    io.to(to).emit("signal", to, from, data);
    console.log(`[SIGNAL] From ${from.substring(0, 8)}... to ${to.substring(0, 8)}...`);
  });

  socket.on("disconnect", () => {
    const roomId = DEFAULT_ROOM;
    const timestamp = new Date().toISOString();
    
    console.log(`\n[${timestamp}] DISCONNECTION`);
    console.log(`  Socket: ${socket.id.substring(0, 8)}...`);
    
    if (rooms[roomId]) {
      rooms[roomId].delete(socket.id);
      const disconnectedPeerId = peerIds[socket.id];
      
      if (disconnectedPeerId) {
        console.log(`  Peer ID: ${disconnectedPeerId.substring(0, 8)}...`);
      }
      
      delete peerIds[socket.id];
      
      // Notificar a los demás usuarios de la sala
      socket.to(roomId).emit("userDisconnected", socket.id);
      console.log(`  📤 Notified other peers about disconnection`);
      
      // Actualizar conteo de usuarios
      io.to(roomId).emit("userCount", rooms[roomId].size);
      console.log(`  📤 Updated user count to: ${rooms[roomId].size}`);
      
      console.log(`  Remaining peers in room: ${rooms[roomId].size}/${MAX_PEERS_PER_ROOM}`);
      
      // Limpiar sala vacía
      if (rooms[roomId].size === 0) {
        delete rooms[roomId];
        console.log(`  🗑️ Room ${roomId} deleted (empty)`);
      }
    } else {
      console.log(`  ⚠️ Socket was not in any room`);
    }
  });
});