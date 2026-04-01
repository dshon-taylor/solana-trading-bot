// WebSocket connection manager - stub
import EventEmitter from 'events';

class WSManager extends EventEmitter{
  constructor(client, opts={}){
    super();
    this.client = client;
    this.maxConnections = opts.maxConnections || 200;
    this.subscriptions = new Set();
    this.state = 'INIT';
  }
  subscribe(mint){
    if(this.subscriptions.size >= this.maxConnections) return false;
    this.subscriptions.add(mint);
    this.emit('subscribed', mint);
    return true;
  }
  unsubscribe(mint){
    this.subscriptions.delete(mint);
    this.emit('unsubscribed', mint);
  }
}

export default WSManager;
