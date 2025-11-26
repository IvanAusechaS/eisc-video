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
console.log(`=`.repeat(50));

let rooms: Record<string, Set<string>> = {};
let peerIds: Record<string, string> = {}; // Mapear socketId -> peerId
const MAX_PEERS_PER_ROOM = 2;
const DEFAULT_ROOM = "main-room";

io.on("connection", (socket) => {
  const roomId = DEFAULT_ROOM;
  
  // Inicializar sala si no existe
  if (!rooms[roomId]) {
    rooms[roomId] = new Set();
  }
  
  const currentPeerCount = rooms[roomId].size;
  
  // Limitar a 2 usuarios por sala
  if (currentPeerCount >= MAX_PEERS_PER_ROOM) {
    console.log(`[REJECTED] Room ${roomId} is full (${currentPeerCount}/${MAX_PEERS_PER_ROOM})`);
    socket.emit("roomFull", { message: "Room is full. Only 2 users allowed." });
    socket.disconnect(true);
    return;
  }

  // Agregar usuario a la sala
  rooms[roomId].add(socket.id);
  socket.join(roomId);
  
  console.log(
    `[CONNECT] Peer ${socket.id.substring(0, 8)}... joined room ${roomId}. Users: ${rooms[roomId].size}/${MAX_PEERS_PER_ROOM}`
  );

  // Cuando un usuario registra su Peer ID
  socket.on("registerPeerId", (peerId: string) => {
    peerIds[socket.id] = peerId;
    console.log(`[PEER_ID] ${socket.id.substring(0, 8)}... registered Peer ID: ${peerId.substring(0, 8)}...`);
    
    // Informar a otros usuarios en la sala del nuevo Peer ID
    const otherPeersInRoom = Array.from(rooms[roomId]).filter(id => id !== socket.id);
    otherPeersInRoom.forEach(otherId => {
      const otherPeerId = peerIds[otherId];
      if (otherPeerId) {
        // Enviar al nuevo usuario el Peer ID del usuario existente
        socket.emit("remotePeerId", otherPeerId);
        // Enviar al usuario existente el Peer ID del nuevo usuario
        io.to(otherId).emit("remotePeerId", peerId);
        console.log(`[EXCHANGE] Exchanged Peer IDs between ${peerId.substring(0, 8)}... and ${otherPeerId.substring(0, 8)}...`);
      }
    });
  });

  socket.on("signal", (to, from, data) => {
    io.to(to).emit("signal", to, from, data);
    console.log(`[SIGNAL] From ${from.substring(0, 8)}... to ${to.substring(0, 8)}...`);
  });

  socket.on("disconnect", () => {
    const roomId = DEFAULT_ROOM;
    
    if (rooms[roomId]) {
      rooms[roomId].delete(socket.id);
      delete peerIds[socket.id]; // Limpiar Peer ID
      
      // Notificar a los demás usuarios de la sala
      socket.to(roomId).emit("userDisconnected", socket.id);
      
      console.log(
        `[DISCONNECT] Peer ${socket.id.substring(0, 8)}... left room ${roomId}. Users: ${rooms[roomId].size}/${MAX_PEERS_PER_ROOM}`
      );
      
      // Limpiar sala vacía
      if (rooms[roomId].size === 0) {
        delete rooms[roomId];
      }
    }
  });
});