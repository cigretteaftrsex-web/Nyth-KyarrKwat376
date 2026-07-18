import express from "express";
import { createServer as createViteServer } from "vite";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";

// In-memory Database
const DB = {
  rooms: [],
  profiles: [],
  guest_profiles: [],
  friendships: [],
  guest_friend_requests: [],
  friend_messages: [],
  room_invites: [],
  user_status: []
};

function generateId() {
  return Math.random().toString(36).substring(2, 10);
}

function applyFilters(rows, filters) {
  let result = rows;
  for (const f of filters) {
    if (f.type === 'eq') result = result.filter(r => r[f.col] == f.val);
    else if (f.type === 'neq') result = result.filter(r => r[f.col] != f.val);
    else if (f.type === 'in') result = result.filter(r => f.vals.includes(r[f.col]));
    else if (f.type === 'ilike') result = result.filter(r => String(r[f.col]).toLowerCase() === String(f.val).toLowerCase());
    else if (f.type === 'or') {
       // extremely simplified 'or' logic specific to the client's use case
       // e.g. "and(requester_id.eq.123,addressee_id.eq.456),and(requester_id.eq.456,addressee_id.eq.123)"
       if (f.val.includes('requester_id.eq')) {
           const match = f.val.match(/requester_id\.eq\.([^,]+),addressee_id\.eq\.([^)]+)/g);
           if (match && match.length === 2) {
              const pair1 = match[0].split(',');
              const u1 = pair1[0].split('.')[2];
              const u2 = pair1[1].split('.')[2];
              result = result.filter(r => 
                 (r.requester_id == u1 && r.addressee_id == u2) ||
                 (r.requester_id == u2 && r.addressee_id == u1)
              );
           }
       }
    }
  }
  return result;
}

function emitPostgresChanges(io, table, event, oldRow, newRow) {
  io.emit('postgres_changes', {
     table, event, old: oldRow, new: newRow
  });
}

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer);
  
  const PORT = 3000;

  // Track channels and presences
  const channels = new Map(); // roomName -> set of socket ids
  const presences = new Map(); // roomName -> map of socket_id -> state

  io.on('connection', (socket) => {
    
    socket.on('join_channel', (channelName, cb) => {
      socket.join(channelName);
      if (!channels.has(channelName)) channels.set(channelName, new Set());
      channels.get(channelName).add(socket.id);
      if (cb) cb();
    });

    socket.on('leave_channel', (channelName) => {
      socket.leave(channelName);
      if (channels.has(channelName)) {
         channels.get(channelName).delete(socket.id);
      }
      if (presences.has(channelName)) {
         presences.get(channelName).delete(socket.id);
         io.to(channelName).emit('presence_sync', { channel: channelName, state: Object.fromEntries(presences.get(channelName)) });
      }
    });

    socket.on('channel_send', ({ channel, data }) => {
      // Broadcast to others in the room
      socket.to(channel).emit('broadcast', { channel, event: data.event, payload: data.payload });
    });

    socket.on('channel_track', ({ channel, state }) => {
      if (!presences.has(channel)) presences.set(channel, new Map());
      presences.get(channel).set(socket.id, [state]);
      io.to(channel).emit('presence_sync', { channel, state: Object.fromEntries(presences.get(channel)) });
    });

    socket.on('disconnect', () => {
      for (const [channel, map] of presences.entries()) {
        if (map.has(socket.id)) {
           map.delete(socket.id);
           io.to(channel).emit('presence_sync', { channel, state: Object.fromEntries(map) });
        }
      }
    });

    socket.on('db_query', ({ table, action, select, filters, payload, order, limit }, cb) => {
      if (!DB[table]) DB[table] = [];
      const rows = DB[table];
      
      try {
        if (action === 'select') {
           let result = applyFilters(rows, filters);
           if (order) {
              result.sort((a, b) => {
                 let va = a[order.col];
                 let vb = b[order.col];
                 if (va < vb) return order.ascending ? -1 : 1;
                 if (va > vb) return order.ascending ? 1 : -1;
                 return 0;
              });
           }
           if (limit) {
              result = result.slice(0, limit);
           }
           cb({ data: result, error: null });
        }
        else if (action === 'insert') {
           const newRow = { id: generateId(), created_at: new Date().toISOString(), ...payload };
           rows.push(newRow);
           emitPostgresChanges(io, table, 'INSERT', null, newRow);
           cb({ data: [newRow], error: null });
        }
        else if (action === 'update') {
           const targets = applyFilters(rows, filters);
           for (const t of targets) {
              const oldRow = { ...t };
              Object.assign(t, payload);
              emitPostgresChanges(io, table, 'UPDATE', oldRow, t);
           }
           cb({ data: targets, error: null });
        }
        else if (action === 'upsert') {
           // We need to check if it exists (usually by id)
           const id = payload.id;
           let existing = null;
           if (id) {
               existing = rows.find(r => r.id === id);
           } else {
               // if filters provided, try to find existing
               const targets = applyFilters(rows, filters);
               if (targets.length > 0) existing = targets[0];
           }
           
           if (existing) {
              const oldRow = { ...existing };
              Object.assign(existing, payload);
              emitPostgresChanges(io, table, 'UPDATE', oldRow, existing);
              cb({ data: [existing], error: null });
           } else {
              const newRow = { id: id || generateId(), created_at: new Date().toISOString(), ...payload };
              rows.push(newRow);
              emitPostgresChanges(io, table, 'INSERT', null, newRow);
              cb({ data: [newRow], error: null });
           }
        }
        else if (action === 'delete') {
           const targets = applyFilters(rows, filters);
           const targetIds = targets.map(t => t.id);
           DB[table] = rows.filter(r => !targetIds.includes(r.id));
           for (const t of targets) {
              emitPostgresChanges(io, table, 'DELETE', t, null);
           }
           cb({ data: targets, error: null });
        }
      } catch (err) {
        cb({ data: null, error: { message: err.message } });
      }
    });

  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
