// Worker entry: serves the client (public/) and routes /ws to a Durable
// Object that owns one running Doom instance per room.

import { DurableObject } from 'cloudflare:workers';
import { DoomEngine, DoomExit, TICRATE } from './doom';

export interface Env {
  DOOM: DurableObjectNamespace<DoomRoom>;
}

// Send every Nth frame: 64000 bytes at 35 fps is ~2.2 MB/s per player.
const FRAME_EVERY_N_TICS = 2;

export class DoomRoom extends DurableObject<Env> {
  private engine?: Promise<DoomEngine>;
  private palette = DoomEngine.palette();
  // Per socket: keys currently held, and keys pressed since the last tic (so
  // a tap shorter than one tic still reaches Doom).
  private players = new Map<WebSocket, { held: number; tapped: number }>();
  private timer?: ReturnType<typeof setInterval>;
  private tics = 0;

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket', { status: 426 });
    }

    const { 0: client, 1: socket } = new WebSocketPair();
    socket.accept();
    this.join(socket);

    return new Response(null, { status: 101, webSocket: client });
  }

  private join(socket: WebSocket): void {
    const input = { held: 0, tapped: 0 };
    this.players.set(socket, input);

    socket.addEventListener('message', (event) => {
      const mask = Number(event.data);
      if (Number.isInteger(mask)) {
        input.held = mask & 0xff;
        input.tapped |= input.held;
      }
    });

    const leave = () => {
      this.players.delete(socket);
      if (this.players.size === 0) this.stop();
    };
    socket.addEventListener('close', leave);
    socket.addEventListener('error', leave);

    socket.send(this.palette);
    this.start();
  }

  private start(): void {
    if (this.timer) return;

    this.engine ??= DoomEngine.create();
    this.engine.then(
      (engine) => {
        if (this.timer || this.players.size === 0) return;
        this.timer = setInterval(() => this.step(engine), 1000 / TICRATE);
      },
      (err) => this.crash(err),
    );
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private step(engine: DoomEngine): void {
    // Everyone in the room drives the same marine.
    let mask = 0;
    for (const input of this.players.values()) {
      mask |= input.held | input.tapped;
      input.tapped = 0;
    }

    try {
      engine.tick(mask);
    } catch (err) {
      this.crash(err);
      return;
    }

    if (++this.tics % FRAME_EVERY_N_TICS === 0) {
      const frame = engine.frame();
      for (const socket of this.players.keys()) {
        try {
          socket.send(frame);
        } catch {
          // Closed between tics; its close event may not have fired yet.
          this.players.delete(socket);
        }
      }
      if (this.players.size === 0) this.stop();
    }
  }

  private crash(err: unknown): void {
    console.error('doom crashed:', err);
    this.stop();
    this.engine = undefined;

    const reason = err instanceof DoomExit ? 'doom exited' : 'doom crashed';
    for (const socket of this.players.keys()) {
      try {
        socket.close(1011, reason);
      } catch {
        // already closed
      }
    }
    this.players.clear();
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const room = url.searchParams.get('room') ?? 'default';
      return env.DOOM.get(env.DOOM.idFromName(room)).fetch(request);
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
