// BirdEye client wrapper (WS + REST) - stub implementation
import EventEmitter from 'events';

const DEFAULTS = {
  wsUrl: process.env.BIRDEYE_WS_URL || 'wss://birdeye.example/ws',
  restUrl: process.env.BIRDEYE_REST_URL || 'https://api.birdeye.example',
  apiKey: process.env.BIRDEYE_API_KEY || ''
};

class BirdEyeClient extends EventEmitter {
  constructor(opts = {}){
    super();
    this.opts = {...DEFAULTS, ...opts};
    this.wsManager = null; // injected by wsManager
  }

  async restFetchSnapshot(mint){
    // simple REST fallback stub
    this.emit('restCall', {mint});
    return {mint, ts: Date.now(), price: 0, volume_5m:0};
  }
}

export default BirdEyeClient;
