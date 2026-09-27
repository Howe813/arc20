// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title InscriptionHub — permissionless arc-20 PoW tick registry and mint gatekeeper
/// @notice NOT a token. Inscriptions live in transaction calldata; balances are
///         computed by the off-chain arc-20 indexer (PROTOCOL.md). Every tick is
///         a FAIR-LAUNCH PoW tick: minting is free but each mint must carry a
///         nonce such that keccak256(miner, tickHash, nonce, mintsOf[miner]) has
///         `difficultyBits` leading zero bits — proof-of-work, enforced on-chain.
///         The miner's mint COUNT is part of the preimage, so a winning solution
///         is single-use: after each successful mint the count advances and the
///         old nonce no longer hashes below difficulty (no nonce recycling).
///         The inscription
///         text is parsed ON-CHAIN; any violation reverts the whole tx, so an
///         invalid attempt never costs anything but gas. The Hub has no owner
///         and no fees: mining replaces payment entirely.
///
///         Difficulty retargets every `epochMints` mints toward an
///         `epochTargetSeconds` epoch duration (Bitcoin-style: slow → easier,
///         fast → harder, clamped to 4x/¼x per epoch), so emission stays on
///         schedule as hashpower joins or leaves.
contract InscriptionHub {
    // canonical PoW mint inscription: PREFIX <tick> AMT_MARKER <amt> NONCE_MARKER <nonce> TAIL
    bytes internal constant PREFIX = 'data:,{"p":"arc-20","op":"mint","tick":"';
    bytes internal constant AMT_MARKER = '","amt":"';
    // the leading quote closes the amt JSON string
    bytes internal constant NONCE_MARKER = '","nonce":"';
    bytes internal constant TAIL = '"}';

    uint8 public constant MAX_DIFFICULTY_BITS = 120; // 2^120 expected hashes — beyond any hardware

    struct TickConfig {
        address deployer;
        uint64 maxMints;
        uint64 totalMints;
        uint32 walletLimit;
        uint128 amountPerMint;
        // PoW parameters
        uint8 difficultyBits; // leading zero bits a mint's hash must show
        uint32 epochMints; // mints per retarget epoch
        uint32 epochTargetSeconds; // target duration of one epoch
        uint32 epochMinted; // mints recorded in the current epoch
        uint64 epochStart; // timestamp the current epoch began
    }

    mapping(bytes32 tickHash => TickConfig) public ticks;
    mapping(bytes32 tickHash => mapping(address wallet => uint64)) public mintsOf;

    event Deployed(
        bytes32 indexed tickHash,
        address indexed deployer,
        string tick,
        uint64 maxMints,
        uint128 amountPerMint,
        uint32 walletLimit,
        uint8 difficultyBits,
        uint32 epochMints,
        uint32 epochTargetSeconds
    );
    event DifficultyRetargeted(bytes32 indexed tickHash, uint8 difficultyBits);
    event Inscribed(bytes32 indexed tickHash, address indexed minter, uint64 inscriptionNumber);

    error BadTick();
    error TickExists();
    error BadParams();
    error BadInscription();
    error BadPow();
    error UnknownTick();
    error WrongPayment();
    error SoldOut();
    error ExceedsWalletLimit();
    error ContractCallerNotAllowed();

    // ---- deploy ----

    /// @notice Fair launch: mint by mining instead of paying. `difficultyBits`
    ///         leading zero bits are required per mint; every `epochMints` mints
    ///         the difficulty retargets so an epoch lasts ~`epochTargetSeconds`
    ///         (clamped to 4x speed-up / 4x slow-down, bounded to [1, MAX]).
    function deployTick(
        string calldata tick,
        uint64 maxMints,
        uint128 amountPerMint,
        uint32 walletLimit,
        uint8 difficultyBits,
        uint32 epochMints,
        uint32 epochTargetSeconds
    ) external {
        bytes calldata t = bytes(tick);
        if (t.length == 0 || t.length > 8) revert BadTick();
        for (uint256 i = 0; i < t.length; i++) {
            bytes1 c = t[i];
            bool ok = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39); // [a-z0-9]
            if (!ok) revert BadTick();
        }
        bytes32 th = keccak256(t);
        if (ticks[th].deployer != address(0)) revert TickExists();
        if (maxMints == 0 || maxMints > 1e9) revert BadParams();
        if (amountPerMint == 0 || amountPerMint > 1e15) revert BadParams();
        if (walletLimit == 0 || walletLimit > maxMints) revert BadParams();
        if (difficultyBits == 0 || difficultyBits > MAX_DIFFICULTY_BITS) revert BadParams();
        if (epochMints == 0 || epochMints > maxMints) revert BadParams();
        if (epochTargetSeconds == 0 || epochTargetSeconds > 365 days) revert BadParams();

        ticks[th] = TickConfig({
            deployer: msg.sender,
            maxMints: maxMints,
            totalMints: 0,
            walletLimit: walletLimit,
            amountPerMint: amountPerMint,
            difficultyBits: difficultyBits,
            epochMints: epochMints,
            epochTargetSeconds: epochTargetSeconds,
            epochMinted: 0,
            epochStart: uint64(block.timestamp)
        });
        emit Deployed(
            th, msg.sender, tick, maxMints, amountPerMint, walletLimit, difficultyBits, epochMints, epochTargetSeconds
        );
    }

    // ---- mint (raw inscription calldata hits the fallback) ----

    /// @dev Rejecting contract callers keeps a factory from sweeping a tick's
    ///      supply through many child contracts in a single transaction.
    fallback() external payable {
        if (msg.sender != tx.origin) revert ContractCallerNotAllowed();

        (bytes32 th, uint256 amt, uint256 nonce) = _parseMint(msg.data);

        TickConfig storage cfg = ticks[th];
        if (cfg.deployer == address(0)) revert UnknownTick();
        if (amt != cfg.amountPerMint) revert BadInscription();
        if (msg.value != 0) revert WrongPayment(); // mining replaces payment

        // Consensus preimage: miner ++ tickHash ++ nonce ++ mintsOf[miner].
        // The per-miner mint count (as of BEFORE this mint) binds every solution
        // to one slot in the miner's emission sequence — once a mint succeeds the
        // count advances below, so the same (miner, tick, nonce) can never pass
        // difficulty twice. Without it, a d=8 solution costs ~256 hashes and one
        // win would unlock a walletLimit=maxMints tick for free.
        bytes32 h = keccak256(abi.encodePacked(msg.sender, th, nonce, mintsOf[th][msg.sender]));
        if (uint256(h) >> (256 - uint256(cfg.difficultyBits)) != 0) revert BadPow();

        // R17 gas: the supply/wallet guards moved BEFORE _retarget so a mint
        // that is destined to fail no longer pays for the retarget's state
        // writes (semantics unchanged — the old order reverted them anyway).
        if (cfg.totalMints >= cfg.maxMints) revert SoldOut();
        uint64 walletMints = mintsOf[th][msg.sender] + 1;
        if (walletMints > cfg.walletLimit) revert ExceedsWalletLimit();

        _retarget(th, cfg);

        mintsOf[th][msg.sender] = walletMints;
        uint64 n;
        unchecked {
            n = ++cfg.totalMints;
        }
        emit Inscribed(th, msg.sender, n);
    }

    /// @dev Epoch bookkeeping. Called after the hash check passes and before the
    ///      mint counters advance; the retarget is derived purely from chain
    ///      timestamps, so indexers replay it deterministically.
    function _retarget(bytes32 th, TickConfig storage cfg) internal {
        uint32 m = cfg.epochMinted + 1;
        if (m < cfg.epochMints) {
            cfg.epochMinted = m;
            return;
        }
        // this mint fills the epoch: retarget toward the target epoch duration.
        // Bitcoin-style: the epoch took `elapsed` seconds for what should have
        // taken `epochTargetSeconds`. Too slow (elapsed > target) → easier, too
        // fast → harder, so the next epoch lands back on target. elapsed == 0
        // (whole epoch inside one timestamp) counts as maximally fast.
        uint256 d = cfg.difficultyBits;
        uint256 elapsed = block.timestamp - cfg.epochStart;
        uint256 nd;
        if (elapsed == 0) {
            nd = d * 4;
        } else {
            nd = (d * cfg.epochTargetSeconds) / elapsed;
            if (nd < d / 4) nd = d / 4;
            if (nd > d * 4) nd = d * 4;
        }
        if (nd == 0) nd = 1;
        if (nd > MAX_DIFFICULTY_BITS) nd = MAX_DIFFICULTY_BITS;
        if (nd != d) {
            cfg.difficultyBits = uint8(nd);
            emit DifficultyRetargeted(th, uint8(nd));
        }
        cfg.epochStart = uint64(block.timestamp);
        cfg.epochMinted = 0;
    }

    /// @dev Plain ETH transfers (empty calldata) are not mints — reject them.
    receive() external payable {
        revert BadInscription();
    }

    /// @dev Strict byte-exact parse of the canonical PoW mint inscription:
    ///      PREFIX <tick> AMT_MARKER <amt> NONCE_MARKER <nonce> TAIL
    ///      Returns (keccak256(tick), amt, nonce). Reverts on ANY deviation.
    ///      (The old `hasNonce` return was always true — a missing nonce reverts
    ///      in the marker comparison — so the flag was dead weight.)
    function _parseMint(bytes calldata d)
        internal
        pure
        returns (bytes32 th, uint256 amt, uint256 nonce)
    {
        uint256 pLen = PREFIX.length;
        uint256 mLen = AMT_MARKER.length;
        // minimum: prefix + 1-char tick + marker + 1-digit amt + nonce marker + 1-digit nonce + tail
        if (d.length < pLen + 1 + mLen + 1 + NONCE_MARKER.length + 1 + TAIL.length) revert BadInscription();
        if (!_matchesConst(d, 0, PREFIX)) revert BadInscription();

        // tick: 1-8 chars of [a-z0-9]
        uint256 i = pLen;
        while (i < d.length && i - pLen < 8) {
            bytes1 c = d[i];
            if ((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39)) i++;
            else break;
        }
        uint256 tickLen = i - pLen;
        if (tickLen == 0) revert BadInscription();
        th = keccak256(d[pLen:i]);

        if (!_matchesConst(d, i, AMT_MARKER)) revert BadInscription();
        i += mLen;

        // amt: decimal digits, no leading zero, bounded length (amountPerMint <= 1e15 => 16 digits).
        // R17: stop at the 16-digit cap BEFORE accumulating — a 77+ digit input
        // used to overflow `amt` inside the loop (Panic 0x11) instead of
        // reverting with the canonical BadInscription error.
        uint256 amtStart = i;
        while (i < d.length && i - amtStart < 16) {
            bytes1 c = d[i];
            if (c < 0x30 || c > 0x39) break;
            amt = amt * 10 + (uint8(c) - 48);
            i++;
        }
        if (i < d.length && d[i] >= 0x30 && d[i] <= 0x39) revert BadInscription(); // 17+ digits
        if (i == amtStart) revert BadInscription();
        if (i - amtStart > 1 && d[amtStart] == "0") revert BadInscription();

        if (!_matchesConst(d, i, NONCE_MARKER)) revert BadInscription();
        i += NONCE_MARKER.length;

        // nonce: decimal digits, "0" allowed, no leading zeros, ≤ 40 digits
        // (fits uint256 with huge margin; bounds gas)
        uint256 nonceStart = i;
        while (i < d.length) {
            bytes1 c = d[i];
            if (c < 0x30 || c > 0x39) break;
            nonce = nonce * 10 + (uint8(c) - 48);
            i++;
        }
        uint256 digits = i - nonceStart;
        if (digits == 0 || digits > 40 || (digits > 1 && d[nonceStart] == "0")) revert BadInscription();

        if (d.length != i + TAIL.length || !_matchesConst(d, i, TAIL)) revert BadInscription();
    }

    /// @dev Byte-wise comparison of a calldata slice against a short constant
    ///      marker at `pos`. Cheaper than materializing the slice and hashing
    ///      both sides with keccak256 for 2-12 byte markers. Bounds-checked.
    function _matchesConst(bytes calldata d, uint256 pos, bytes memory marker) internal pure returns (bool) {
        if (pos + marker.length > d.length) return false;
        for (uint256 k = 0; k < marker.length; k++) {
            if (d[pos + k] != marker[k]) return false;
        }
        return true;
    }
}
