// arc-20 PoW helpers — pure JS keccak-256, zero dependencies.
// One source of truth shared by three consumers:
//   - indexer.mjs (independent PoW verification while replaying blocks)
//   - the browser miner (module worker imports /keccak.mjs from this file)
//   - e2e/e2e.mjs (mines nonces on anvil)
// The hash preimage MUST stay byte-identical to the Hub contract (consensus v2):
//   keccak256(abi.encodePacked(msg.sender, tickHash, uint256(nonce), uint64(mintsOf)))
// The trailing mint count is the miner's ALREADY-COMPLETED mint tally for the
// tick (0 for the first mint) — it makes every solution single-use.
// A mint is valid when the hash has `difficultyBits` leading zero bits,
// i.e. uint256(hash) >> (256 - difficultyBits) == 0 in Solidity terms.

// keccak256(bytes: Uint8Array) -> 0x-prefixed 64-hex-char digest
export function keccak256(bytes) {
  const A = [[0n,0n,0n,0n,0n],[0n,0n,0n,0n,0n],[0n,0n,0n,0n,0n],[0n,0n,0n,0n,0n],[0n,0n,0n,0n,0n]];
  const rate = 136;
  const buf = new Uint8Array(bytes.length + (rate - (bytes.length % rate)));
  buf.set(bytes);
  buf[bytes.length] ^= 0x01;
  buf[buf.length - 1] ^= 0x80;
  for (let off = 0; off < buf.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 0; j < 8; j++) lane |= BigInt(buf[off + i * 8 + j]) << BigInt(8 * j);
      A[i % 5][(i / 5) | 0] ^= lane;
    }
    for (let r = 0; r < 24; r++) {
      const C = [0n,0n,0n,0n,0n];
      for (let x = 0; x < 5; x++) C[x] = A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4];
      const D = [0n,0n,0n,0n,0n];
      for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ krotl(C[(x + 1) % 5], 1n);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] ^= D[x];
      const B = [[0n,0n,0n,0n,0n],[0n,0n,0n,0n,0n],[0n,0n,0n,0n,0n],[0n,0n,0n,0n,0n],[0n,0n,0n,0n,0n]];
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y][(2 * x + 3 * y) % 5] = krotl(A[x][y], KECCAK_ROT[x][y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] = B[x][y] ^ ((B[(x + 1) % 5][y] ^ KMASK) & B[(x + 2) % 5][y]);
      A[0][0] ^= KECCAK_RC[r];
    }
  }
  let out = "0x";
  let p = 0;
  for (let i = 0; i < rate / 8 && p < 32; i++) {
    const lane = A[i % 5][(i / 5) | 0];
    for (let j = 0; j < 8 && p < 32; j++, p++) out += Number((lane >> BigInt(8 * j)) & 0xffn).toString(16).padStart(2, "0");
  }
  return out;
}
const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const KECCAK_ROT = [
  [0n, 36n, 3n, 41n, 18n], [1n, 44n, 10n, 45n, 2n], [62n, 6n, 43n, 15n, 61n],
  [28n, 55n, 25n, 21n, 56n], [27n, 20n, 39n, 8n, 14n],
];
const KMASK = (1n << 64n) - 1n;
const krotl = (x, n) => ((x << n) | (x >> (64n - n))) & KMASK;

// Build the 92-byte mint preimage: address (20B) ++ tickHash (32B) ++
// nonce (uint256 big-endian 32B) ++ mint count (uint64 big-endian 8B).
// mintsBig is REQUIRED (consensus v2): passing nothing throws instead of
// silently hashing a stale preimage.
export function powPreimage(addrHex, tickHashHex, nonceBig, mintsBig) {
  if (mintsBig === undefined) {
    throw new Error("powPreimage: mint count required (v2 preimage = miner++tickHash++nonce++mintsOf)");
  }
  const out = new Uint8Array(92);
  const addr = hexToBytes(addrHex, 20);
  const th = hexToBytes(tickHashHex, 32);
  out.set(addr, 0);
  out.set(th, 20);
  let n = BigInt(nonceBig);
  for (let i = 83; i >= 52; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  let m = BigInt(mintsBig);
  if (m < 0n || m > 0xffffffffffffffffn) throw new Error("powPreimage: mint count out of uint64 range");
  for (let i = 91; i >= 84; i--) {
    out[i] = Number(m & 0xffn);
    m >>= 8n;
  }
  return out;
}
function hexToBytes(hex, len) {
  const h = String(hex).replace(/^0x/, "").toLowerCase().padStart(len * 2, "0");
  if (h.length !== len * 2) throw new Error("bad hex length");
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

// True when the 0x-hex digest has at least `bits` leading zero bits
// (equivalent to BigInt(digest) >> (256n - bits) === 0n, without BigInt per hash).
export function meetsDifficulty(digestHex, bits) {
  if (bits <= 0) return true;
  if (bits > 256) return false;
  const h = digestHex.replace(/^0x/, "").toLowerCase();
  const nibbles = bits >> 2; // whole zero hex chars required
  const rem = bits & 3; // remaining bits within the next char
  for (let i = 0; i < nibbles; i++) if (h[i] !== "0") return false;
  if (rem === 0) return true;
  const c = parseInt(h[nibbles], 16);
  return c < (1 << (4 - rem));
}

// Hash one preimage and test difficulty — the miner's inner loop.
// mintsBig = the miner's completed mint count for this tick BEFORE this mint.
export function powCheck(addrHex, tickHashHex, nonceBig, bits, mintsBig) {
  return meetsDifficulty(keccak256(powPreimage(addrHex, tickHashHex, nonceBig, mintsBig)), bits);
}
