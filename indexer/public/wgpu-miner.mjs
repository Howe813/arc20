// arc-20 WebGPU 挖矿引擎 — WGSL keccak-f[1600] + 批量调度
// 预映像(与合约/keccak.mjs 严格一致,92 字节 + keccak 填充到 136):
//   keccak256(addr(20B) ++ tickHash(32B) ++ nonce(32B BE) ++ mints(8B BE))
// GPU 每线程只重写 nonce 低 64 位所在的 words[19]/[20](大端→小端转换),
// 其余 32 字直接从 baseWords 拷贝;前导零位数达标即原子登记第一个解。
//
// 注意:WGSL 无 u64,全部用 (lo,hi) u32 对实现 64 位运算。

const SHADER = `
struct Params {
  base: array<u32, 34>,   // 136 字节填充块(LE u32 × 34),nonce 段为占位 0
  nonceLo: u32,
  nonceHi: u32,
  bits: u32,              // 要求的前导零位数
  count: u32,             // 本批线程数
};
struct Out {
  flag: atomic<u32>,      // 0 = 本批未找到;1 = 已找到(首个解登记)
  nonceLo: atomic<u32>,
  nonceHi: atomic<u32>,
  digest: array<u32, 8>,  // 线程 0 的哈希摘要(自校验用,LE u32 × 8)
};
@group(0) @binding(0) var<storage, read> params: Params;
@group(0) @binding(1) var<storage, read_write> out: Out;

fn bswap(v: u32) -> u32 {
  return ((v & 0xffu) << 24u) | ((v & 0xff00u) << 8u) | ((v >> 8u) & 0xff00u) | ((v >> 24u) & 0xffu);
}

fn rotl(lo: u32, hi: u32, n: u32) -> vec2<u32> {
  if (n == 0u) { return vec2<u32>(lo, hi); }
  if (n == 32u) { return vec2<u32>(hi, lo); }
  if (n < 32u) {
    return vec2<u32>((lo << n) | (hi >> (32u - n)), (hi << n) | (lo >> (32u - n)));
  }
  let m = n - 32u;
  return vec2<u32>((hi << m) | (lo >> (32u - m)), (lo << m) | (hi >> (32u - m)));
}

const RC_LO = array<u32, 24>(
  0x00000001u, 0x00008082u, 0x0000808au, 0x80008000u,
  0x0000808bu, 0x80000001u, 0x80008081u, 0x00008009u,
  0x0000008au, 0x00000088u, 0x80008009u, 0x8000000au,
  0x8000808bu, 0x0000008bu, 0x00008089u, 0x00008003u,
  0x00008002u, 0x00000080u, 0x0000800au, 0x8000000au,
  0x80008081u, 0x00008080u, 0x80000001u, 0x80008008u,
);
const RC_HI = array<u32, 24>(
  0x00000000u, 0x00000000u, 0x80000000u, 0x80000000u,
  0x00000000u, 0x00000000u, 0x80000000u, 0x80000000u,
  0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u,
  0x00000000u, 0x80000000u, 0x80000000u, 0x80000000u,
  0x80000000u, 0x80000000u, 0x00000000u, 0x80000000u,
  0x80000000u, 0x80000000u, 0x00000000u, 0x80000000u,
);

// 旋转偏移 ρ:flat idx = x + 5y(与 lane i ↔ A[i%5][i/5] 一致)
const ROT = array<u32, 25>(
  0u, 1u, 62u, 28u, 27u,
  36u, 44u, 6u, 55u, 20u,
  3u, 10u, 43u, 25u, 39u,
  41u, 45u, 15u, 21u, 8u,
  18u, 2u, 61u, 56u, 14u,
);

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let digestOut = gid.x == 0u;
  if (gid.x >= params.count) { return; }

  // nonce = base + gid.x(u32 模 2^32 回绕,比较判进位)
  var lo = params.nonceLo + gid.x;
  var hi = params.nonceHi;
  if (lo < params.nonceLo) { hi = hi + 1u; }

  // 136 字节块 → 25 个 (lo,hi) lane;lane L 的 lo/hi = base[2L]/base[2L+1]
  // ⚠️ 消息块只覆盖前 17 个 lane(136 字节);capacity(lane 17..24)必须为 0
  var alo: array<u32, 25>;
  var ahi: array<u32, 25>;
  for (var i = 0u; i < 17u; i++) {
    alo[i] = params.base[i * 2u];
    ahi[i] = params.base[i * 2u + 1u];
  }
  for (var i = 17u; i < 25u; i++) {
    alo[i] = 0u;
    ahi[i] = 0u;
  }
  // 重写 nonce 低 64 位:word19 = lane9.hi(字节 76..79 = nonceHi BE)、word20 = lane10.lo(80..83 = nonceLo BE)
  ahi[9] = bswap(hi);
  alo[10] = bswap(lo);

  // keccak-f[1600] × 24 轮
  // const 数组不能用运行时下标 → 拷贝为函数内 var
  var rcLo = array<u32, 24>(RC_LO[0u], RC_LO[1u], RC_LO[2u], RC_LO[3u], RC_LO[4u], RC_LO[5u], RC_LO[6u], RC_LO[7u],
    RC_LO[8u], RC_LO[9u], RC_LO[10u], RC_LO[11u], RC_LO[12u], RC_LO[13u], RC_LO[14u], RC_LO[15u],
    RC_LO[16u], RC_LO[17u], RC_LO[18u], RC_LO[19u], RC_LO[20u], RC_LO[21u], RC_LO[22u], RC_LO[23u]);
  var rcHi = array<u32, 24>(RC_HI[0u], RC_HI[1u], RC_HI[2u], RC_HI[3u], RC_HI[4u], RC_HI[5u], RC_HI[6u], RC_HI[7u],
    RC_HI[8u], RC_HI[9u], RC_HI[10u], RC_HI[11u], RC_HI[12u], RC_HI[13u], RC_HI[14u], RC_HI[15u],
    RC_HI[16u], RC_HI[17u], RC_HI[18u], RC_HI[19u], RC_HI[20u], RC_HI[21u], RC_HI[22u], RC_HI[23u]);
  var rotTab = array<u32, 25>(ROT[0u], ROT[1u], ROT[2u], ROT[3u], ROT[4u], ROT[5u], ROT[6u], ROT[7u], ROT[8u], ROT[9u],
    ROT[10u], ROT[11u], ROT[12u], ROT[13u], ROT[14u], ROT[15u], ROT[16u], ROT[17u], ROT[18u], ROT[19u],
    ROT[20u], ROT[21u], ROT[22u], ROT[23u], ROT[24u]);
  for (var round = 0u; round < 24u; round++) {
    // theta
    var clo: array<u32, 5>;
    var chi: array<u32, 5>;
    for (var x = 0u; x < 5u; x++) {
      let i0 = x; let i1 = x + 5u; let i2 = x + 10u; let i3 = x + 15u; let i4 = x + 20u;
      clo[x] = alo[i0] ^ alo[i1] ^ alo[i2] ^ alo[i3] ^ alo[i4];
      chi[x] = ahi[i0] ^ ahi[i1] ^ ahi[i2] ^ ahi[i3] ^ ahi[i4];
    }
    for (var x = 0u; x < 5u; x++) {
      // D[x] = C[(x+4)%5] ^ rotl(C[(x+1)%5], 1)
      let r = rotl(clo[(x + 1u) % 5u], chi[(x + 1u) % 5u], 1u);
      let dlo = clo[(x + 4u) % 5u] ^ r.x;
      let dhi = chi[(x + 4u) % 5u] ^ r.y;
      for (var y = 0u; y < 5u; y++) {
        let i = x + 5u * y;
        alo[i] = alo[i] ^ dlo;
        ahi[i] = ahi[i] ^ dhi;
      }
    }
    // rho + pi:B[y][(2x+3y)%5] = rotl(A[x][y], rotTab[x+5y])
    var blo: array<u32, 25>;
    var bhi: array<u32, 25>;
    for (var x = 0u; x < 5u; x++) {
      for (var y = 0u; y < 5u; y++) {
        let r = rotl(alo[x + 5u * y], ahi[x + 5u * y], rotTab[x + 5u * y]);
        blo[y + 5u * ((2u * x + 3u * y) % 5u)] = r.x;
        bhi[y + 5u * ((2u * x + 3u * y) % 5u)] = r.y;
      }
    }
    // chi
    for (var x = 0u; x < 5u; x++) {
      for (var y = 0u; y < 5u; y++) {
        let i = x + 5u * y;
        let i1 = ((x + 1u) % 5u) + 5u * y; // B[(x+1)%5][y]
        let i2 = ((x + 2u) % 5u) + 5u * y; // B[(x+2)%5][y]
        alo[i] = blo[i] ^ ((blo[i1] ^ 0xffffffffu) & blo[i2]);
        ahi[i] = bhi[i] ^ ((bhi[i1] ^ 0xffffffffu) & bhi[i2]);
      }
    }
    // iota
    alo[0] = alo[0] ^ rcLo[round];
    ahi[0] = ahi[0] ^ rcHi[round];
  }

  if (digestOut) {
    out.digest[0] = alo[0]; out.digest[1] = ahi[0];
    out.digest[2] = alo[1]; out.digest[3] = ahi[1];
    out.digest[4] = alo[2]; out.digest[5] = ahi[2];
    out.digest[6] = alo[3]; out.digest[7] = ahi[3];
  }

  // 前导零位数检查:digest 字节 = lane LE 字节序,先 lane0.lo → lane0.hi → lane1.lo…
  var z = 0u;
  var ok = true;
  var words: array<u32, 4> = array<u32, 4>(alo[0], ahi[0], alo[1], ahi[1]);
  for (var k = 0u; k < 16u; k++) {
    let byte = (words[k / 4u] >> ((k % 4u) * 8u)) & 0xffu;
    if (byte == 0u) { z = z + 8u; continue; }
    z = z + countLeadingZeros(byte) - 24u;
    if (z < params.bits) { ok = false; }
    break;
  }

  if (ok) {
    let first = atomicAdd(&out.flag, 1u);
    if (first == 0u) {
      atomicStore(&out.nonceLo, lo);
      atomicStore(&out.nonceHi, hi);
    }
  }
}
`;

const RATE_BYTES = 136;

export class GpuMiner {
  constructor(device, pipeline, bindGroup, paramsBuf, outBuf, staging, info) {
    this.device = device;
    this.pipeline = pipeline;
    this.bindGroup = bindGroup;
    this.paramsBuf = paramsBuf;
    this.outBuf = outBuf;
    this.staging = staging;
    this.info = info;
  }

  static async create() {
    if (!navigator.gpu) throw new Error("WebGPU not available");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("no GPU adapter");
    const device = await adapter.requestDevice();
    const info = adapter.info?.vendor || adapter.info?.architecture || "GPU";
    const module = device.createShaderModule({ code: SHADER });
    // WGSL 编译错误是异步的:显式抓取编译信息,失败即抛(避免管线静默空跑)
    const info2 = await module.getCompilationInfo();
    const errs = info2.messages.filter((x) => x.type === "error");
    if (errs.length) {
      throw new Error("shader compile: " + errs.map((x) => `L${x.lineNum}: ${x.message}`).join(" | ").slice(0, 400));
    }
    const pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    const paramsBuf = device.createBuffer({ size: 38 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const outBuf = device.createBuffer({
      size: (3 + 8) * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    const staging = device.createBuffer({ size: (3 + 8) * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramsBuf } },
        { binding: 1, resource: { buffer: outBuf } },
      ],
    });
    const m = new GpuMiner(device, pipeline, bindGroup, paramsBuf, outBuf, staging, info);
    m.baseWords = new Uint32Array(34);
    return m;
  }

  /** 设置本作业的固定块(除 nonce 外全部字节):miner 地址 + tickHash + 已铸张数 */
  setBase(minerHex, tickHashHex, mintsBig) {
    const b = new Uint8Array(RATE_BYTES); // 零填充
    const wr = (off, hex, len) => {
      const h = String(hex).replace(/^0x/, "").toLowerCase();
      for (let i = 0; i < len; i++) b[off + i] = parseInt(h.substr(i * 2, 2), 16);
    };
    wr(0, minerHex, 20);
    wr(20, tickHashHex, 32);
    // nonce 段(52..83)占位 0,GPU 线程自行覆写
    let m = BigInt(mintsBig);
    for (let i = 91; i >= 84; i--) { b[i] = Number(m & 0xffn); m >>= 8n; }
    b[92] = 0x01; // pad
    b[RATE_BYTES - 1] = 0x80;
    for (let i = 0; i < 34; i++) {
      this.baseWords[i] =
        b[4 * i] | (b[4 * i + 1] << 8) | (b[4 * i + 2] << 16) | (b[4 * i + 3] << 24);
    }
  }

  /**
   * 跑一批:count 个 nonce(自 nonceBase 起)。返回 {found, nonceBig, hashes, ms}。
   * count ≤ 256×65535;调用方按算力百分比控制 count 与节奏。
   */
  async mineBatch(nonceBaseBig, bits, count) {
    const lo = Number(nonceBaseBig & 0xffffffffn);
    const hi = Number((nonceBaseBig >> 32n) & 0xffffffffn);
    const params = new Uint32Array(38);
    params.set(this.baseWords, 0);
    params[34] = lo;
    params[35] = hi;
    params[36] = bits;
    params[37] = count;
    this.device.queue.writeBuffer(this.paramsBuf, 0, params);
    this.device.queue.writeBuffer(this.outBuf, 0, new Uint32Array(11)); // 清 flag/nonce/digest

    const t0 = performance.now();
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(count / 256));
    pass.end();
    enc.copyBufferToBuffer(this.outBuf, 0, this.staging, 0, 11 * 4);
    this.device.queue.submit([enc.finish()]);
    await this.device.queue.onSubmittedWorkDone();
    await this.staging.mapAsync(GPUMapMode.READ);
    const res = new Uint32Array(this.staging.getMappedRange().slice(0));
    this.staging.unmap();
    const ms = Math.max(1, performance.now() - t0);

    const nonceBig = (BigInt(res[2]) << 32n) | BigInt(res[1]);
    return {
      found: res[0] !== 0,
      nonceBig,
      hashes: count,
      ms,
      // 线程 0 摘要(自校验):lane LE u32 → 32 字节 BE hex
      digestHex:
        "0x" +
        Array.from(res.slice(3, 11))
          .map((w) => {
            let h = "";
            for (let k = 0; k < 4; k++) h += ((w >>> (8 * k)) & 0xff).toString(16).padStart(2, "0");
            return h;
          })
          .join(""),
    };
  }

  destroy() {
    try { this.device.destroy(); } catch (_) {}
  }
}
