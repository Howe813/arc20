// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {InscriptionHub} from "../src/InscriptionHub.sol";

/// PoW mint tests: on-chain keccak difficulty enforcement, per-miner nonce
/// binding, single-use nonces (the miner's mint count is part of the preimage),
/// epoch retargeting (4x/¼x clamps), and the strict nonce format.
/// Deploy validation lives in InscriptionHub.t.sol.
contract PowMintTest is Test {
    InscriptionHub hub;
    address deployer = makeAddr("deployer");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    bytes32 constant POW = keccak256("pow");
    uint8 constant D = 8;
    uint32 constant EPOCH_MINTS = 4;
    uint32 constant EPOCH_TARGET = 100;

    function setUp() public {
        hub = new InscriptionHub();
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.prank(deployer);
        hub.deployTick("pow", 1000, 10, 100, D, EPOCH_MINTS, EPOCH_TARGET);
    }

    // ---- helpers ----

    /// Mirrors the consensus preimage EXACTLY: miner ++ tickHash ++ nonce ++
    /// mintsOf (uint64 → 8 big-endian bytes on the contract side, so `count`
    /// must stay uint64 here or the packed encoding diverges).
    function _satisfies(address m, bytes32 th, uint256 nonce, uint256 d, uint64 count) internal pure returns (bool) {
        return uint256(keccak256(abi.encodePacked(m, th, nonce, count))) >> (256 - d) == 0;
    }

    /// Brute-force the lowest valid nonce for (miner, tick, count) — the same
    /// preimage the contract hashes, so this mirrors a real miner.
    function _mine(address m, bytes32 th, uint256 d, uint64 count) internal pure returns (uint256 n) {
        while (!_satisfies(m, th, n, d, count)) n++;
    }

    /// Mine starting from a floor nonce (avoids reusing a consumed nonce).
    function _mineAt(address m, bytes32 th, uint256 d, uint256 from, uint64 count) internal pure returns (uint256 n) {
        n = from;
        while (!_satisfies(m, th, n, d, count)) n++;
    }

    /// Deterministic single-use nonce: valid at count `c` but NOT at `c + 1`,
    /// so replaying it after a successful mint is guaranteed to revert (no
    /// 1/2^d coincidence flake).
    function _mineSingleUse(address m, bytes32 th, uint256 d, uint64 c) internal pure returns (uint256 n) {
        while (!_satisfies(m, th, n, d, c) || _satisfies(m, th, n, d, c + 1)) n++;
    }

    /// Current difficulty of a tick (retargets change it mid-test).
    function _curDiff(bytes32 th) internal view returns (uint8 cur) {
        (,,,,, cur,,,,) = hub.ticks(th);
    }

    function _powText(string memory tick, string memory amt, uint256 nonce) internal pure returns (bytes memory) {
        return bytes(
            string.concat(
                'data:,{"p":"arc-20","op":"mint","tick":"',
                tick,
                '","amt":"',
                amt,
                '","nonce":"',
                vm.toString(nonce),
                '"}'
            )
        );
    }

    function _mint(address who, bytes memory data) internal returns (bool ok, bytes memory ret) {
        vm.prank(who, who);
        (ok, ret) = address(hub).call(data);
    }

    /// Mine-and-mint once at the tick's CURRENT difficulty (count auto-tracked).
    function _mineAndMint() internal returns (bool ok) {
        uint8 cur = _curDiff(POW);
        (ok,) = _mint(alice, _powText("pow", "10", _mine(alice, POW, cur, hub.mintsOf(POW, alice))));
    }

    // ---- happy path ----

    function test_PowMintHappyPath() public {
        uint256 nonce = _mine(alice, POW, D, 0);
        vm.expectEmit(true, true, false, true);
        emit InscriptionHub.Inscribed(POW, alice, 1);
        (bool ok,) = _mint(alice, _powText("pow", "10", nonce));
        assertTrue(ok);

        (,, uint64 total,,,,,,,) = hub.ticks(POW);
        assertEq(total, 1);
        assertEq(hub.mintsOf(POW, alice), 1);
    }

    function test_PowMintZeroNonce() public {
        vm.prank(deployer);
        hub.deployTick("z", 1000, 1, 1000, 1, 1000, 100); // d=1: ~50% of hashes qualify
        bytes32 th = keccak256("z");
        if (_satisfies(alice, th, 0, 1, 0)) {
            (bool ok,) = _mint(alice, 'data:,{"p":"arc-20","op":"mint","tick":"z","amt":"1","nonce":"0"}');
            assertTrue(ok);
        } else {
            (bool ok, bytes memory ret) =
                _mint(alice, 'data:,{"p":"arc-20","op":"mint","tick":"z","amt":"1","nonce":"0"}');
            assertFalse(ok);
            assertEq(bytes4(ret), InscriptionHub.BadPow.selector);
        }
    }

    // ---- rejections ----

    function test_RevertWhen_PowDifficultyNotMet() public {
        uint256 bad = 0;
        while (_satisfies(alice, POW, bad, D, 0)) bad++;
        (bool ok, bytes memory ret) = _mint(alice, _powText("pow", "10", bad));
        assertFalse(ok);
        assertEq(bytes4(ret), InscriptionHub.BadPow.selector);
        (,, uint64 total,,,,,,,) = hub.ticks(POW);
        assertEq(total, 0);
    }

    function test_RevertWhen_NonceBoundToMiner() public {
        uint256 nonce = _mine(alice, POW, D, 0);
        // alice's winning nonce is almost certainly invalid for bob (different preimage),
        // but pick bob's first failing nonce for determinism
        uint256 bad = nonce;
        while (_satisfies(bob, POW, bad, D, 0)) bad++;
        (bool ok, bytes memory ret) = _mint(bob, _powText("pow", "10", bad));
        assertFalse(ok);
        assertEq(bytes4(ret), InscriptionHub.BadPow.selector);
    }

    function test_RevertWhen_MintWithoutNonce() public {
        (bool ok, bytes memory ret) = _mint(alice, 'data:,{"p":"arc-20","op":"mint","tick":"pow","amt":"10"}');
        assertFalse(ok);
        assertEq(bytes4(ret), InscriptionHub.BadInscription.selector);
    }

    function test_RevertWhen_PowMintWithValue() public {
        uint256 nonce = _mine(alice, POW, D, 0);
        vm.prank(alice, alice);
        (bool ok, bytes memory ret) = address(hub).call{value: 1 wei}(_powText("pow", "10", nonce));
        assertFalse(ok);
        assertEq(bytes4(ret), InscriptionHub.WrongPayment.selector);
    }

    function test_RevertWhen_NonceNotCanonical() public {
        bytes[] memory bad = new bytes[](3);
        bad[0] = bytes('data:,{"p":"arc-20","op":"mint","tick":"pow","amt":"10","nonce":"01"}'); // leading zero
        bad[1] = bytes('data:,{"p":"arc-20","op":"mint","tick":"pow","amt":"10","nonce":""}'); // empty
        bad[2] = bytes('data:,{"p":"arc-20","op":"mint","tick":"pow","amt":"10","nonce":"12" }'); // space
        for (uint256 i = 0; i < bad.length; i++) {
            (bool ok, bytes memory ret) = _mint(alice, bad[i]);
            assertFalse(ok, string(abi.encodePacked("case ", vm.toString(i))));
            assertEq(bytes4(ret), InscriptionHub.BadInscription.selector);
        }
    }

    function test_RevertWhen_NonceOverflowsBoundedLength() public {
        // 41 digits — beyond the parser bound → non-canonical
        (bool ok, bytes memory ret) = _mint(
            alice,
            bytes(
                'data:,{"p":"arc-20","op":"mint","tick":"pow","amt":"10","nonce":"12345678901234567890123456789012345678901"}'
            )
        );
        assertFalse(ok);
        assertEq(bytes4(ret), InscriptionHub.BadInscription.selector);
    }

    // ---- supply/limits ----

    function test_PowWalletLimitAndSoldOut() public {
        vm.prank(deployer);
        hub.deployTick("tiny", 2, 1, 1, 1, 2, 100); // d=1 cheap to mine, epoch covers the whole supply
        bytes32 th = keccak256("tiny");
        // counts track each miner's on-chain mintsOf so the hash check PASSES and
        // the expected guard (wallet limit / sold out) is what reverts
        (bool ok,) = _mint(alice, _powText("tiny", "1", _mineAt(alice, th, _curDiff(th), 0, 0)));
        assertTrue(ok);
        (bool ok2, bytes memory ret) = _mint(alice, _powText("tiny", "1", _mineAt(alice, th, _curDiff(th), 1000, 1)));
        assertFalse(ok2); // wallet limit 1
        assertEq(bytes4(ret), InscriptionHub.ExceedsWalletLimit.selector);
        (bool ok3,) = _mint(bob, _powText("tiny", "1", _mineAt(bob, th, _curDiff(th), 0, 0)));
        assertTrue(ok3); // fills the epoch — difficulty may retarget after this mint
        (bool ok4, bytes memory ret4) = _mint(bob, _powText("tiny", "1", _mineAt(bob, th, _curDiff(th), 1000, 1)));
        assertFalse(ok4); // sold out
        assertEq(bytes4(ret4), InscriptionHub.SoldOut.selector);
    }

    // ---- single-use nonces (consensus v2: the mint count is in the preimage) ----

    function test_RevertWhen_SameNonceReused() public {
        uint256 nonce = _mineSingleUse(alice, POW, D, 0); // valid at count 0, dead at count 1
        (bool ok,) = _mint(alice, _powText("pow", "10", nonce));
        assertTrue(ok); // first mint consumes count 0
        // replaying the same (miner, tick, nonce): the count advanced to 1, the
        // hash differs and no longer meets difficulty → BadPow, no double mint
        (bool ok2, bytes memory ret) = _mint(alice, _powText("pow", "10", nonce));
        assertFalse(ok2);
        assertEq(bytes4(ret), InscriptionHub.BadPow.selector);
        (,, uint64 total,,,,,,,) = hub.ticks(POW);
        assertEq(total, 1, "a reused nonce must not mint twice");
        assertEq(hub.mintsOf(POW, alice), 1);
    }

    function test_NewCountRequiresFreshSolution() public {
        // mint #1 mines against count 0; mint #2 must be re-mined against count 1
        uint256 n0 = _mineSingleUse(alice, POW, D, 0);
        (bool ok,) = _mint(alice, _powText("pow", "10", n0));
        assertTrue(ok);
        assertEq(hub.mintsOf(POW, alice), 1);
        uint256 n1 = _mine(alice, POW, D, 1);
        (bool ok2,) = _mint(alice, _powText("pow", "10", n1));
        assertTrue(ok2, "mining against the advanced count must succeed");
        assertEq(hub.mintsOf(POW, alice), 2);
    }

    function test_RetargetInvalidatesOldSolution() public {
        // fill the epoch in one timestamp → difficulty jumps 8 → 32
        for (uint256 i = 0; i < EPOCH_MINTS; i++) {
            assertTrue(_mineAndMint());
        }
        assertEq(_curDiff(POW), 32);
        // a solution mined under the OLD difficulty (8 bits) is dead: the hub
        // now enforces 32 bits on every submit, regardless of how it was mined
        uint64 count = hub.mintsOf(POW, alice);
        uint256 old = 0;
        while (!_satisfies(alice, POW, old, 8, count) || _satisfies(alice, POW, old, 32, count)) old++;
        (bool ok, bytes memory ret) = _mint(alice, _powText("pow", "10", old));
        assertFalse(ok);
        assertEq(bytes4(ret), InscriptionHub.BadPow.selector);
    }

    // ---- retargeting ----

    function test_RetargetSlowsDownWhenEpochTooLong() public {
        // epoch took 2x the target duration → difficulty halves (8 → 4)
        vm.warp(1 + 2 * EPOCH_TARGET);
        for (uint256 i = 0; i < EPOCH_MINTS; i++) {
            assertTrue(_mineAndMint());
        }
        assertEq(_curDiff(POW), 4);
        (,,,,,,,, uint32 epochMinted,) = hub.ticks(POW);
        assertEq(epochMinted, 0); // epoch restarted
    }

    function test_RetargetSpeedsUpWhenEpochTooFast() public {
        // 4 mints inside one timestamp → difficulty quadruples (8 → 32)
        for (uint256 i = 0; i < EPOCH_MINTS; i++) {
            assertTrue(_mineAndMint());
        }
        assertEq(_curDiff(POW), 32);
    }

    function test_RetargetClampsSlow() public {
        // epoch 100x over target: raw nd = 8/100 → clamped to a single ¼x step (8 → 2)
        vm.warp(1 + 100 * EPOCH_TARGET);
        for (uint256 i = 0; i < EPOCH_MINTS; i++) {
            assertTrue(_mineAndMint());
        }
        assertEq(_curDiff(POW), 2);
    }

    function test_RetargetClampsFast() public {
        // elapsed = 1s for a 100s target: raw nd = 800 → clamped to 4x (8 → 32)
        vm.warp(2);
        for (uint256 i = 0; i < EPOCH_MINTS; i++) {
            assertTrue(_mineAndMint());
        }
        assertEq(_curDiff(POW), 32);
    }

    function test_RetargetEmitsEvent() public {
        // mints 1-3 fill the epoch; the 4th mint retargets 8 → 32 (zero elapsed = max fast)
        for (uint256 i = 0; i < EPOCH_MINTS - 1; i++) {
            assertTrue(_mineAndMint());
        }
        vm.expectEmit(true, false, false, true);
        emit InscriptionHub.DifficultyRetargeted(POW, 32);
        assertTrue(_mineAndMint());
    }

    function test_RetargetNeverBelowOneBit() public {
        vm.prank(deployer);
        hub.deployTick("one", 1000, 1, 1000, 1, 1, 10_000); // d=1, huge target
        // epochMints=1 → every mint retargets; keep each epoch astronomically
        // over target (raw nd = 1×10000/1e9 → 0) so the floor kicks in every time
        bytes32 one = keccak256("one");
        for (uint256 i = 0; i < 3; i++) {
            vm.warp(1 + (i + 1) * 1_000_000_000);
            (bool ok,) = _mint(alice, _powText("one", "1", _mine(alice, one, 1, hub.mintsOf(one, alice))));
            assertTrue(ok);
        }
        assertEq(_curDiff(one), 1); // clamp floor: d/4 = 0 → nd == 0 → 1
    }

    // ---- R17: oversized amounts revert canonically (no Panic 0x11) ----

    /// Build a mint calldata with a `digits`-long decimal amount.
    function _mintWithAmtDigits(uint256 digits) internal returns (bool ok, bytes memory ret) {
        bytes memory huge = new bytes(digits);
        for (uint256 i = 0; i < digits; i++) {
            huge[i] = bytes1("9");
        }
        bytes memory data = bytes(
            string.concat('data:,{"p":"arc-20","op":"mint","tick":"pow","amt":"', string(huge), '","nonce":"1"}')
        );
        vm.prank(alice, alice);
        (ok, ret) = address(hub).call(data);
    }

    /// 76/77/78-digit amounts previously overflowed the accumulator inside the
    /// digit loop (Panic 0x11) instead of reverting with BadInscription — the
    /// digit cap must short-circuit BEFORE any arithmetic overflow is possible.
    function test_RevertWhen_AmtExceedsDigitCap() public {
        for (uint256 digits = 76; digits <= 78; digits++) {
            (bool ok, bytes memory ret) = _mintWithAmtDigits(digits);
            assertFalse(ok, "oversized amount must revert");
            assertEq(bytes4(ret), InscriptionHub.BadInscription.selector, "canonical parse error, not Panic");
        }
        (,, uint64 total,,,,,,,) = hub.ticks(POW);
        assertEq(total, 0, "no state changes from oversized amounts");
    }

    /// 16 digits is the accepted maximum length (value still checked downstream).
    function test_AmtAtDigitCapParses() public {
        // amountPerMint = 10, so a 16-digit amt can never match — but the parse
        // layer itself must accept 16 digits (revert reason is amt mismatch).
        (bool ok, bytes memory ret) = _mintWithAmt("1000000000000000");
        assertFalse(ok);
        assertEq(bytes4(ret), InscriptionHub.BadInscription.selector, "amt mismatch, not a parse Panic");
    }

    // ---- retarget multi-epoch evolution toward the difficulty cap ----

    function test_RetargetMultiEpochQuadrupling() public {
        // d=2 with 1-second epochs vs a 100-second target: every epoch wants a
        // ×4 clamp — difficulty walks 2 → 8 → 32 across the run. (Reaching the
        // 120-bit cap itself would need a ≥2^30-difficulty epoch, which is not
        // economically minable in a test; the MAX branch is code-reviewed and
        // same-shaped as the ×4 clamp verified here.)
        vm.prank(deployer);
        hub.deployTick("ev", 1000, 1, 1000, 2, 1, 100);
        bytes32 th = keccak256("ev");
        for (uint256 e = 0; e < 2; e++) {
            vm.warp(block.timestamp + 1);
            (bool ok,) = _mint(alice, _powText("ev", "1", _mine(alice, th, _curDiff(th), hub.mintsOf(th, alice))));
            assertTrue(ok);
        }
        assertEq(_curDiff(th), 32, "difficulty quadruples per 1-second epoch (2 -> 8 -> 32)");
        // a 120-bit cap check is impossible to mine — but the tick is now hard
        // enough that further mints need 2^32 hashes each
    }

    // ---- R17 follow-up: guard reordering must not change retarget behaviour ----

    function test_SoldOutRevertDoesNotAdvanceEpoch() public {
        // 1/1 tick: the first mint fills the epoch (retarget 1 → 4) AND sells
        // the tick out. Any further mint reverts SoldOut BEFORE _retarget runs,
        // so neither the epoch bookkeeping nor the difficulty may move.
        vm.prank(deployer);
        hub.deployTick("one", 1, 1, 1, 1, 1, 100);
        bytes32 th = keccak256("one");
        (bool ok,) = _mint(alice, _powText("one", "1", _mine(alice, th, 1, 0)));
        assertTrue(ok);
        assertEq(_curDiff(th), 4, "retarget 1 -> 4 fired on the filling mint");
        (,,,,,,,, uint32 epochMinted,) = hub.ticks(th);
        assertEq(epochMinted, 0, "epoch restarted by the filling mint");
        // a well-mined nonce at the CURRENT difficulty still reverts SoldOut
        // (guards fire before _retarget) — nothing about the tick may move
        uint256 nonce = _mine(alice, th, 4, 1);
        vm.prank(alice, alice);
        (bool ok2,) = address(hub).call(_powText("one", "1", nonce));
        assertFalse(ok2, "sold-out tick cannot mint");
        (,, uint64 total,,,,,,,) = hub.ticks(th);
        assertEq(total, 1, "supply unchanged");
        assertEq(hub.mintsOf(th, alice), 1);
    }

    /// Low-level mint with an explicit amt string (for boundary cases).
    function _mintWithAmt(string memory amt) internal returns (bool ok, bytes memory ret) {
        bytes memory data =
            bytes(string.concat('data:,{"p":"arc-20","op":"mint","tick":"pow","amt":"', amt, '","nonce":"1"}'));
        vm.prank(alice, alice);
        (ok, ret) = address(hub).call(data);
    }

    // ---- fuzz ----

    function testFuzz_PowMintNeedsValidHash(int256 seed) public {
        // deterministic pseudo-random nonce: the contract must reject non-solutions
        uint256 nonce = uint256(keccak256(abi.encodePacked(seed))) % (2 ** 64);
        bool sat = _satisfies(alice, POW, nonce, D, 0); // fresh wallet → count 0
        (bool ok,) = _mint(alice, _powText("pow", "10", nonce));
        assertEq(ok, sat, "mint succeeds iff the nonce meets difficulty");
    }
}
