// Procedural engine sound, physically informed (after Baldan et al. 2015,
// "Physically informed car engine sound synthesis for virtual and augmented
// environments").
//
// Each cylinder makes three pressure events per four-stroke cycle: the
// exhaust blowdown when its exhaust valve opens, suction while its intake
// valve is open, and a knock into the block when it fires. The exhaust pulses
// then travel through modelled pipes (header, straight pipe, muffler, tailpipe)
// built from delay-line resonators. Those pipes have fixed resonances, so as
// the firing rate sweeps through them the timbre changes with rpm the way a
// real engine's does.
//
// Plain JS on purpose: the same file is loaded as an AudioWorklet module and
// imported on the main thread (for the CPU benchmark), and it must be served
// as-is in both dev and build. Types live in engine-worklet.d.ts.

const TAU = Math.PI * 2;

// Pulse shapes as lookup tables: the inner loop runs once per cylinder per
// sample, so no pow/cos there.
const LUT = 1024;
/** exhaust blowdown: sharp rise, slower fall, smooth at both ends */
const EX_PULSE = new Float32Array(LUT + 1);
/** intake suction: half sine */
const IN_PULSE = new Float32Array(LUT + 1);
for (let i = 0; i <= LUT; i++) {
  const x = i / LUT;
  EX_PULSE[i] = 0.5 - 0.5 * Math.cos(TAU * Math.pow(x, 0.6));
  IN_PULSE[i] = Math.sin(Math.PI * x);
}

/**
 * Engine layouts. `fire` = firing angles over the 720° cycle, `bank` = which
 * exhaust each one goes to, `gain` evens out loudness between layouts.
 */
export const LAYOUTS = {
  i4: { name: 'Inline-4', fire: [0, 180, 360, 540], bank: [0, 0, 0, 0], gain: 0.62 },
  // boxer four (1-3-2-4): evenly spaced, but each side's pair fires back to
  // back and then rests a whole turn, so each bank's pipe gets a lumpy pulse
  flat4: { name: 'Flat-4', fire: [0, 180, 360, 540], bank: [0, 0, 1, 1], gain: 0.84 },
  i6: { name: 'Inline-6', fire: [0, 120, 240, 360, 480, 600], bank: [0, 0, 0, 0, 0, 0], gain: 1 },
  flat6: { name: 'Flat-6', fire: [0, 120, 240, 360, 480, 600], bank: [0, 1, 0, 1, 0, 1], gain: 1.35 },
  // cross-plane V8 (1-8-4-3-6-5-7-2): each bank gets its pulses unevenly, the
  // classic burble
  v8x: { name: 'V8 cross-plane', fire: [0, 90, 180, 270, 360, 450, 540, 630], bank: [0, 1, 1, 0, 1, 0, 0, 1], gain: 1.3 },
  v8f: { name: 'V8 flat-plane', fire: [0, 90, 180, 270, 360, 450, 540, 630], bank: [0, 1, 0, 1, 0, 1, 0, 1], gain: 1.2 },
  v10: { name: 'V10', fire: [0, 72, 144, 216, 288, 360, 432, 504, 576, 648], bank: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1], gain: 1.35 },
  v12: { name: 'V12', fire: [0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660], bank: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1], gain: 1.45 },
  // two rotors fire once per shaft turn each: an I4's rate with long, raspy
  // port openings
  rotary: { name: '2-rotor rotary', fire: [0, 180, 360, 540], bank: [0, 0, 0, 0], gain: 0.9 },
};

export const DEFAULT_PARAMS = {
  layout: 'i6',
  /** exhaust: headers, straight pipe, muffler chambers, tailpipe (metres) */
  header: 0.75,
  pipe: 1.6,
  muffler: 0.35,
  tail: 0.3,
  /** 0..1: how hard the muffler damps the sound (higher = quieter, duller) */
  damping: 0.55,
  /** lowpass on the exhaust note, Hz */
  bright: 3200,
  /** exhaust valve opening width, degrees of crank */
  pulseWidth: 150,
  /** turbulent noise riding on each exhaust pulse */
  rasp: 0.35,
  /** cylinder-to-cylinder difference in strength and timing */
  uneven: 0.25,
  /** cycle-to-cycle randomness */
  jitter: 0.12,
  /** mix levels */
  intake: 0.35,
  intakeLen: 0.35,
  block: 0.3,
  /** overrun pops: about crackle × 20 per second off the throttle, up to 10× that right after a lift-off */
  crackle: 0.04,
  /** 'recorded' plays real pops once the page has sent them, 'synth' makes them */
  popStyle: 'recorded',
  popVolume: 1.3,
  turbo: 0,
  /** stereo width for twin exhausts */
  width: 0.5,
  volume: 0.8,
};

/** One-pole lowpass. */
class OnePole {
  constructor() { this.a = 0.5; this.z = 0; }
  set(hz, sr) { this.a = 1 - Math.exp(-TAU * Math.min(hz, sr * 0.45) / sr); }
  run(x) { this.z += this.a * (x - this.z); return this.z; }
}

/** Two-pole resonant bandpass (RBJ, constant 0 dB peak). */
class Band {
  constructor() { this.b0 = this.b2 = this.a1 = this.a2 = 0; this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  set(hz, q, sr) {
    const w = TAU * Math.min(hz, sr * 0.45) / sr;
    const al = Math.sin(w) / (2 * q);
    const a0 = 1 + al;
    this.b0 = al / a0; this.b2 = -al / a0;
    this.a1 = -2 * Math.cos(w) / a0; this.a2 = (1 - al) / a0;
  }
  run(x) {
    const y = this.b0 * x + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/**
 * A pipe section: the wave runs to the far end and back (round trip 2L/c)
 * and partly reflects, inverted at an open end. A feedback comb with a
 * lowpass in the loop for the losses.
 */
class Pipe {
  constructor(maxLen) { this.buf = new Float32Array(maxLen); this.i = 0; this.len = 2; this.g = -0.5; this.lp = new OnePole(); }
  set(metres, c, reflect, lossHz, sr) {
    this.len = Math.max(2, Math.min(this.buf.length - 1, Math.round((2 * metres / c) * sr)));
    this.g = reflect;
    this.lp.set(lossHz, sr);
  }
  run(x) {
    let j = this.i - this.len;
    if (j < 0) j += this.buf.length;
    const y = x + this.g * this.lp.run(this.buf[j]);
    this.buf[this.i] = y;
    if (++this.i === this.buf.length) this.i = 0;
    return y;
  }
}

/** One exhaust system: header → straight pipe → muffler chambers → tailpipe. */
class Exhaust {
  constructor(sr) {
    const max = Math.ceil(sr * 0.05);
    this.header = new Pipe(max);
    this.pipe = new Pipe(max);
    this.cham = [new Pipe(max), new Pipe(max), new Pipe(max)];
    this.tail = new Pipe(max);
    this.lp = new OnePole();
    this.hp = 0;
    this.hpA = 0;
  }
  set(p, bankOffset, sr) {
    const c = 520; // speed of sound in hot exhaust gas, m/s
    this.header.set(p.header * (1 + bankOffset), c, -0.55, 5200, sr);
    this.pipe.set(p.pipe, c, -0.45, 4200, sr);
    // muffler: three chambers of slightly different size, damping sets how
    // much each one rings
    const fb = 0.35 + 0.5 * p.damping;
    this.cham[0].set(p.muffler, c, fb, 2200, sr);
    this.cham[1].set(p.muffler * 1.37, c, fb * 0.9, 1800, sr);
    this.cham[2].set(p.muffler * 0.71, c, fb * 0.8, 2600, sr);
    this.mufDirect = 1 - 0.75 * p.damping;
    this.tail.set(p.tail, c, -0.3, 6000, sr);
    this.lp.set(p.bright, sr);
    this.hpA = Math.exp(-TAU * 70 / sr); // open-end radiation: low end rolls off
  }
  run(x) {
    let y = this.header.run(x);
    y = this.pipe.run(y);
    y = this.mufDirect * y + 0.3 * (this.cham[0].run(y) + this.cham[1].run(y) + this.cham[2].run(y));
    y = this.tail.run(y);
    y = this.lp.run(y);
    // one-pole highpass
    const out = y - this.hp;
    this.hp = y - out * this.hpA;
    return out;
  }
}

/** The whole engine. Pure DSP: no Web Audio here, so it runs anywhere. */
export class EngineDsp {
  constructor(sampleRate, params) {
    this.sr = sampleRate;
    this.p = { ...DEFAULT_PARAMS, ...(params || {}) };
    this.phase = 0;
    this.rpm = 900;
    this.load = 0;
    this.spool = 0;
    this.lastTarget = 0;
    this.seed = 1234567;
    this.ex = [new Exhaust(sampleRate), new Exhaust(sampleRate)];
    this.intakePipe = new Pipe(Math.ceil(sampleRate * 0.02));
    this.intakeLp = new OnePole();
    this.blockRes = [new Band(), new Band(), new Band()];
    this.raspLp = new OnePole();
    this.turboLp = new OnePole();
    this.bov = 0; // blow-off valve envelope
    this.bovBand = new Band();
    // afterfire: unburnt fuel left in the hot exhaust, and the pops it makes
    this.fuel = 0;
    this.prevPh = new Float32Array(16);
    /** recorded pops, sorted by size; null until the page sends them */
    this.popBank = null;
    /** recorded pops playing right now */
    this.voices = [];
    /** called with each pop's size as it fires */
    this.onPop = null;
    // synthesized pops: a pressure spike per bank and a short crack
    this.thump = [0, 0];
    this.thumpK = [0, 0];
    this.crack = [0, 0];
    this.crackBand = new Band();
    this.dc = [0, 0];
    this.dcY = [0, 0];
    this.whistle = 0;
    this.setParams(this.p);
  }

  rand() {
    // xorshift, cheaper than Math.random in a hot loop and repeatable
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 4294967296;
  }

  setParams(params) {
    Object.assign(this.p, params);
    const p = this.p;
    const lay = LAYOUTS[p.layout] || LAYOUTS.i6;
    this.n = lay.fire.length;
    this.fire = lay.fire.map((d) => d / 720);
    this.bank = lay.bank.slice();
    this.banks = Math.max(...this.bank) + 1;
    this.rotary = p.layout === 'rotary';
    this.layoutGain = lay.gain;
    // fixed per-cylinder character: some cylinders a little stronger or
    // later than others, which is what makes an engine lumpy instead of a buzz
    let s = 99991;
    const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    this.cylAmp = this.fire.map(() => 1 + (r() - 0.5) * 0.6 * p.uneven);
    this.cylLag = this.fire.map(() => (r() - 0.5) * 0.02 * p.uneven);
    this.cycAmp = this.fire.map(() => 1);
    this.cycLag = this.fire.map(() => 0);
    this.ex[0].set(p, 0, this.sr);
    this.ex[1].set(p, 0.12, this.sr);
    this.intakePipe.set(p.intakeLen, 343, -0.6, 3000, this.sr);
    this.intakeLp.set(1800, this.sr);
    this.blockRes[0].set(160, 5, this.sr);
    this.blockRes[1].set(480, 7, this.sr);
    this.blockRes[2].set(1250, 9, this.sr);
    this.raspLp.set(this.rotary ? 6000 : 4000, this.sr);
    this.turboLp.set(300, this.sr);
    this.bovBand.set(2400, 1.2, this.sr);
    this.crackBand.set(3200, 0.9, this.sr);
    this.crackK = Math.exp(-1 / (0.0018 * this.sr));
    this.pw = (this.rotary ? 260 : p.pulseWidth) / 720;
  }

  /** Recorded pops to use: `{ big, mid, small }`, each a list of mono buffers at this sample rate. */
  setPops(bank) {
    this.popBank = bank && (bank.big.length || bank.mid.length || bank.small.length) ? bank : null;
  }

  /** A pop now (a gear change or the mini-turbo, say). */
  pop(strength = 1) {
    this.firePop(Math.min(1, strength), this.rand() < 0.5 ? 0 : 1);
  }

  /** One afterfire bang from bank `bk`'s exhaust, `amp` 0..1. */
  firePop(amp, bk) {
    // tell whoever is listening (the game shows a flame at the tailpipe)
    if (this.onPop) this.onPop(amp);
    const b = this.banks > 1 ? bk : 0;
    const pb = this.popBank;
    if (this.p.popStyle !== 'synth' && pb) {
      const cls = amp > 0.75 && pb.big.length ? pb.big : amp > 0.5 && pb.mid.length ? pb.mid : pb.small.length ? pb.small : pb.big.length ? pb.big : pb.mid;
      const buf = cls[(this.rand() * cls.length) | 0];
      if (this.voices.length >= 5) this.voices.shift();
      this.voices.push({
        buf,
        pos: 0,
        // bigger bangs a touch deeper; every pop a little different
        rate: 1.12 - 0.25 * amp + this.rand() * 0.16,
        gain: 0.35 + 0.65 * amp,
        pan: this.banks > 1 ? (b ? 0.3 : -0.3) * this.p.width * 2 : (this.rand() - 0.5) * 0.2,
      });
    } else {
      // synthesized: a pressure spike into this bank's header, so the exhaust
      // rings with its own pipes, plus a short bright crack at the tailpipe
      this.thump[b] = Math.max(this.thump[b], amp);
      this.thumpK[b] = Math.exp(-1 / ((0.003 + 0.01 * amp) * this.sr));
      this.crack[b] = Math.max(this.crack[b], amp);
    }
  }

  /**
   * Cylinder k's exhaust valve just opened while off the throttle: maybe its
   * unburnt charge lights off. `crackle` sets pops per second; leftover fuel
   * from a fresh lift-off makes a dense burst that thins out.
   */
  afterfire(k) {
    const perSec = this.p.crackle * 100 * (0.2 + 1.8 * this.fuel) * Math.min(1, this.rpm / 4500);
    const eventsPerSec = this.n * this.rpm / 120;
    if (this.rand() >= Math.min(0.6, perSec / eventsPerSec)) return;
    const r = this.rand();
    const amp = Math.min(1, 0.25 + 0.75 * r * r * (0.5 + this.fuel));
    this.fuel = Math.max(0, this.fuel - 0.05);
    this.firePop(amp, this.bank[k]);
  }

  newCycle() {
    const j = this.p.jitter;
    for (let k = 0; k < this.n; k++) {
      this.cycAmp[k] = 1 + (this.rand() - 0.5) * 0.8 * j;
      this.cycLag[k] = (this.rand() - 0.5) * 0.01 * j;
    }
  }

  /**
   * Render one block. `rpm`/`load` are targets; they glide per sample so
   * fast changes from the game don't click.
   */
  render(outL, outR, frames, rpmTarget, loadTarget) {
    const sr = this.sr;
    const p = this.p;
    const n = this.n;
    const pw = this.pw;
    const sRpm = 1 - Math.exp(-1 / (0.012 * sr));
    const sLoad = 1 - Math.exp(-1 / (0.02 * sr));
    const vol = p.volume * this.layoutGain;
    const w = this.banks > 1 ? p.width : 0;
    const turbo = p.turbo;
    const ex0 = this.ex[0];
    const ex1 = this.ex[1];
    // lifting off a spooled turbo vents it through the blow-off valve
    if (turbo > 0 && this.lastTarget - loadTarget > 0.4 && this.spool > 0.4) this.bov = this.spool;
    // lifting off at revs leaves unburnt fuel in the hot exhaust: it lights
    // off as a burst of pops that thins out over a second or two
    if (loadTarget < 0.15 && this.lastTarget >= 0.5 && this.rpm > 2500) {
      this.fuel = Math.min(1, this.fuel + 0.5 + 0.5 * Math.min(1, this.rpm / 7000));
    }
    this.fuel *= Math.exp(-frames / sr / (loadTarget > 0.3 ? 0.08 : 1.4));
    this.lastTarget = loadTarget;
    const popVol = p.popVolume * p.volume;
    for (let f = 0; f < frames; f++) {
      this.rpm += (rpmTarget - this.rpm) * sRpm;
      this.load += (loadTarget - this.load) * sLoad;
      const rpm = this.rpm;
      const load = this.load;
      this.phase += rpm / 120 / sr; // one 4-stroke cycle per two revolutions
      if (this.phase >= 1) { this.phase -= 1; this.newCycle(); }

      // exhaust blowdown strength: hard on throttle, a soft burble off it
      const drive = 0.32 + 0.68 * load;
      let exA = 0, exB = 0, intake = 0, knock = 0, noiseEnv = 0;
      for (let k = 0; k < n; k++) {
        let ph = this.phase - this.fire[k] - this.cylLag[k] - this.cycLag[k];
        ph -= Math.floor(ph);
        const amp = this.cylAmp[k] * this.cycAmp[k];
        // exhaust valve opens ~140° after the cylinder fires
        if (ph >= 0.194 && this.prevPh[k] < 0.194 && load < 0.15 && rpm > 1800 && p.crackle > 0) this.afterfire(k);
        this.prevPh[k] = ph;
        const x = (ph - 0.194) / pw;
        if (x > 0 && x < 1) {
          const e = EX_PULSE[(x * LUT) | 0];
          const v = e * amp;
          if (this.bank[k] === 0) exA += v; else exB += v;
          noiseEnv += e;
        }
        // intake stroke: 360°–540° after firing, suction
        const xi = (ph - 0.5) * 4;
        if (xi > 0 && xi < 1) intake -= IN_PULSE[(xi * LUT) | 0] * amp;
        // ignition knock into the block
        if (ph < 0.03) knock += (1 - ph / 0.03) * amp;
      }
      // turbulent rasp riding on the pulses
      const noise = this.rand() * 2 - 1;
      const rasp = this.raspLp.run(noise) * noiseEnv * p.rasp * (0.4 + load);
      exA = exA * drive + rasp * (this.banks > 1 ? 0.5 : 1);
      exB = exB * drive + rasp * 0.5;

      // synthesized pops: the pressure spike goes in at the headers
      if (this.thump[0] > 0.0005) { exA += this.thump[0] * 3; this.thump[0] *= this.thumpK[0]; } else this.thump[0] = 0;
      if (this.thump[1] > 0.0005) { exB += this.thump[1] * 3; this.thump[1] *= this.thumpK[1]; } else this.thump[1] = 0;

      let a = ex0.run(exA);
      let b = this.banks > 1 ? ex1.run(exB) : 0;

      // intake: suction pulses into the airbox, plus roar at high load
      let it = this.intakePipe.run(intake * (0.2 + 0.8 * load) + noise * 0.15 * load * Math.min(1, rpm / 6000));
      it = this.intakeLp.run(it) * p.intake;

      // block: ignition knock ringing the engine's own resonances
      const kn = knock * (0.3 + 0.7 * load) * (0.6 + 0.4 * noise);
      const blk = (this.blockRes[0].run(kn) + 0.6 * this.blockRes[1].run(kn) + 0.3 * this.blockRes[2].run(kn)) * p.block * 2.5;

      // turbo: whistle that rises with spool, blow-off hiss when you lift
      let tb = 0;
      if (turbo > 0) {
        const want = load * Math.min(1, Math.max(0, (rpm - 2200) / 3500));
        this.spool += (want - this.spool) * (want > this.spool ? 1.2 : 2.5) / sr;
        this.whistle += (2200 + 6500 * this.spool) / sr;
        if (this.whistle > 1) this.whistle -= 1;
        tb = Math.sin(TAU * this.whistle) * this.spool * this.spool * 0.05 * (0.3 + load);
        if (this.bov > 0.001) {
          const flutter = 0.6 + 0.4 * Math.sin(TAU * this.phase * 6);
          tb += this.bovBand.run(noise) * this.bov * 0.9 * flutter;
          this.bov *= 0.99985;
        }
        tb *= turbo;
      }

      const common = it + blk + tb;
      let l, r;
      if (this.banks > 1) {
        l = a * (1 + w) + b * (1 - w);
        r = b * (1 + w) + a * (1 - w);
        l *= 0.5; r *= 0.5;
      } else {
        l = r = a;
      }
      // the synth pop's crack, right at the tailpipe
      let crk = 0;
      if (this.crack[0] + this.crack[1] > 0.0005) {
        crk = this.crackBand.run(noise) * (this.crack[0] + this.crack[1]) * 1.4;
        this.crack[0] *= this.crackK;
        this.crack[1] *= this.crackK;
      }
      // recorded pops
      let pl = 0, pr = 0;
      for (let v = this.voices.length - 1; v >= 0; v--) {
        const vo = this.voices[v];
        const i0 = vo.pos | 0;
        const buf = vo.buf;
        if (i0 + 1 >= buf.length) { this.voices.splice(v, 1); continue; }
        const s = (buf[i0] + (buf[i0 + 1] - buf[i0]) * (vo.pos - i0)) * vo.gain;
        pl += s * (1 - vo.pan);
        pr += s * (1 + vo.pan);
        vo.pos += vo.rate;
      }
      l = (l + common + crk) * vol + pl * popVol;
      r = (r + common + crk) * vol + pr * popVol;
      // DC blocker, then a soft clip so pops can't blow up the output
      const yl = l - this.dc[0] + 0.995 * this.dcY[0];
      this.dc[0] = l; this.dcY[0] = yl;
      const yr = r - this.dc[1] + 0.995 * this.dcY[1];
      this.dc[1] = r; this.dcY[1] = yr;
      outL[f] = Math.tanh(yl * 0.5);
      outR[f] = Math.tanh(yr * 0.5);
    }
  }
}

// Registered only inside an AudioWorkletGlobalScope; on the main thread this
// file just exports the DSP.
if (typeof AudioWorkletProcessor !== 'undefined' && typeof registerProcessor === 'function') {
  class EngineProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [
        { name: 'rpm', defaultValue: 900, minValue: 0, maxValue: 20000, automationRate: 'k-rate' },
        { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      ];
    }
    constructor(options) {
      super();
      this.dsp = new EngineDsp(sampleRate, options && options.processorOptions && options.processorOptions.params);
      this.dsp.onPop = (amp) => this.port.postMessage({ type: 'popped', amp });
      this.alive = true;
      this.busy = 0;
      this.frames = 0;
      this.canTime = typeof performance !== 'undefined' && typeof performance.now === 'function';
      this.port.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'params') this.dsp.setParams(m.params);
        else if (m.type === 'pop') this.dsp.pop(m.strength);
        else if (m.type === 'pops') this.dsp.setPops(m.bank);
        else if (m.type === 'stop') this.alive = false;
      };
    }
    process(_inputs, outputs, parameters) {
      const out = outputs[0];
      const l = out[0];
      const r = out[1] || out[0];
      const t0 = this.canTime ? performance.now() : 0;
      this.dsp.render(l, r, l.length, parameters.rpm[0], parameters.load[0]);
      if (this.canTime) {
        this.busy += performance.now() - t0;
        this.frames += l.length;
        if (this.frames >= sampleRate / 2) {
          // share of real time spent rendering this engine
          this.port.postMessage({ type: 'cpu', share: this.busy / (1000 * this.frames / sampleRate) });
          this.busy = 0;
          this.frames = 0;
        }
      }
      return this.alive;
    }
  }
  registerProcessor('peace-engine', EngineProcessor);
}
