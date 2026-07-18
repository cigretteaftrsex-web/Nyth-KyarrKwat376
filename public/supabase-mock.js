window.supabase = {
  createClient: (url, key) => {
    if (!window._mockSupabaseClient) {
      window._mockSupabaseClient = new MockSupabaseClient();
    }
    return window._mockSupabaseClient;
  }
};

class MockSupabaseClient {
  constructor() {
    this.socket = io();
    this.auth = new MockAuth(this.socket);
    this.channels = new Map();
    
    this.socket.on('postgres_changes', (payload) => {
       for (const [name, ch] of this.channels.entries()) {
          for (const sub of ch.subscriptions) {
             if (sub.type === 'postgres_changes') {
                const f = sub.filter;
                if (f.table === payload.table && (!f.event || f.event === '*' || f.event === payload.event)) {
                   let match = true;
                   if (f.filter) {
                      const parts = f.filter.split('=');
                      if (parts.length >= 2) {
                          const col = parts[0];
                          const opVal = parts.slice(1).join('=');
                          if (opVal.startsWith('eq.')) {
                             const v = opVal.substring(3);
                             if (payload.new && payload.new[col] != v) match = false;
                          }
                      }
                   }
                   if (match) sub.callback(payload);
                }
             }
          }
       }
    });

    this.socket.on('broadcast', (payload) => {
       const ch = this.channels.get(payload.channel);
       if (ch) {
          for (const sub of ch.subscriptions) {
             if (sub.type === 'broadcast' && sub.filter.event === payload.event) {
                sub.callback({ payload: payload.payload });
             }
          }
       }
    });

    this.socket.on('presence_sync', (payload) => {
       const ch = this.channels.get(payload.channel);
       if (ch) {
          ch._presenceState = payload.state;
          for (const sub of ch.subscriptions) {
             if (sub.type === 'presence' && sub.filter.event === 'sync') {
                sub.callback();
             }
          }
       }
    });
  }

  from(table) {
    return new QueryBuilder(this.socket, table);
  }

  channel(name, config) {
    if (this.channels.has(name)) return this.channels.get(name);
    const ch = new MockChannel(this.socket, name, config);
    this.channels.set(name, ch);
    return ch;
  }

  removeChannel(ch) {
    if (typeof ch === 'string') {
       this.socket.emit('leave_channel', ch);
       this.channels.delete(ch);
    } else if (ch && ch.name) {
       this.socket.emit('leave_channel', ch.name);
       this.channels.delete(ch.name);
    }
  }
}

class MockAuth {
  constructor(socket) {
    this.socket = socket;
    this.listeners = [];
  }
  async getSession() {
    const session = localStorage.getItem('mock_session');
    if (session) return { data: { session: JSON.parse(session) }, error: null };
    return { data: { session: null }, error: null };
  }
  onAuthStateChange(cb) {
    this.listeners.push(cb);
    const session = localStorage.getItem('mock_session');
    if (session) {
      setTimeout(() => cb('SIGNED_IN', JSON.parse(session)), 10);
    } else {
      setTimeout(() => cb('INITIAL_SESSION', null), 10);
    }
    return { data: { subscription: { unsubscribe: () => {} } } };
  }
  async signInWithOAuth(opts) {
    const name = prompt("Google Auth Simulation\n\nEnter your name to login:") || "Test User";
    const user = {
      id: "u_" + Math.random().toString(36).substring(2, 10),
      email: name.replace(/\s/g, '').toLowerCase() + "@gmail.com",
      user_metadata: { full_name: name, avatar_url: "https://api.dicebear.com/7.x/avataaars/svg?seed=" + name }
    };
    const session = { user, access_token: "mock_token" };
    localStorage.setItem('mock_session', JSON.stringify(session));
    window.location.reload();
  }
  async signOut() {
    localStorage.removeItem('mock_session');
    window.location.reload();
  }
}

class MockChannel {
  constructor(socket, name, config) {
    this.socket = socket;
    this.name = name;
    this.config = config;
    this.subscriptions = [];
    this._presenceState = {};
  }
  on(type, filter, callback) {
    this.subscriptions.push({ type, filter, callback });
    return this;
  }
  subscribe(callback) {
    this.socket.emit('join_channel', this.name, () => {
       if (callback) callback('SUBSCRIBED');
    });
    return this;
  }
  send(data) {
    this.socket.emit('channel_send', { channel: this.name, data });
  }
  track(state) {
    this.socket.emit('channel_track', { channel: this.name, state });
  }
  presenceState() {
    return this._presenceState;
  }
}

class QueryBuilder {
  constructor(socket, table) {
    this.socket = socket;
    this.table = table;
    this._action = 'select'; // default
    this._select = '*';
    this._filters = []; this._order = null; this._limit = null;
    this._payload = null;
    this._single = false;
    this._maybeSingle = false;
  }
  
  select(cols = '*') { this._action = 'select'; this._select = cols; return this; }
  insert(payload) { this._action = 'insert'; this._payload = payload; return this; }
  update(payload) { this._action = 'update'; this._payload = payload; return this; }
  upsert(payload) { this._action = 'upsert'; this._payload = payload; return this; }
  delete() { this._action = 'delete'; return this; }

  eq(col, val) { this._filters.push({ type: 'eq', col, val }); return this; }
  neq(col, val) { this._filters.push({ type: 'neq', col, val }); return this; }
  ilike(col, val) { this._filters.push({ type: 'ilike', col, val }); return this; }
  in(col, vals) { this._filters.push({ type: 'in', col, vals }); return this; }
  or(val) { this._filters.push({ type: 'or', val }); return this; }
  order(col, opts) { this._order = { col, ascending: opts ? opts.ascending : false }; return this; }
  limit(count) { this._limit = count; return this; }
  
  single() { this._single = true; return this; }
  maybeSingle() { this._maybeSingle = true; return this; }

  then(resolve, reject) {
    this.execute().then(resolve).catch(reject);
  }

  async execute() {
    return new Promise((resolve) => {
      this.socket.emit('db_query', {
         table: this.table,
         action: this._action,
         select: this._select,
         filters: this._filters,
         payload: this._payload,
         order: this._order,
         limit: this._limit
      }, (response) => {
         if (response.error) {
             resolve({ data: null, error: response.error });
         } else {
             let data = response.data;
             if (this._action === 'select' || this._action === 'insert' || this._action === 'update' || this._action === 'upsert') {
                 if (this._single) {
                     if (!data || data.length === 0) resolve({ data: null, error: { message: 'Row not found' } });
                     else resolve({ data: data[0], error: null });
                 } else if (this._maybeSingle) {
                     if (!data || data.length === 0) resolve({ data: null, error: null });
                     else resolve({ data: data[0], error: null });
                 } else {
                     resolve({ data, error: null });
                 }
             } else {
                 resolve({ data, error: null });
             }
         }
      });
    });
  }
}
