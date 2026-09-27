// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {InscriptionHub} from "../src/InscriptionHub.sol";

contract MintProxy {
    function tryMint(InscriptionHub hub, bytes calldata data) external payable {
        (bool ok, bytes memory ret) = address(hub).call{value: msg.value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}

/// Deploy + parse-surface tests for the PoW-only Hub. Mint/retarget behavior
/// lives in PowMint.t.sol.
contract InscriptionHubTest is Test {
    InscriptionHub hub;
    address deployer = makeAddr("deployer");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    bytes32 constant ROBIN = keccak256("robin");
    uint8 constant D = 8; // cheap test difficulty (~256 hashes per mint)

    function setUp() public {
        hub = new InscriptionHub();
        vm.prank(deployer);
        hub.deployTick("robin", 21_000, 1000, 10, D, 21_000, 600);
    }

    /// Mirrors the consensus preimage exactly: miner ++ tickHash ++ nonce ++
    /// mintsOf (uint64 → 8 bytes, same encoding as the contract's counter).
    function _satisfies(address m, bytes32 th, uint256 nonce, uint256 d, uint64 count) internal pure returns (bool) {
        return uint256(keccak256(abi.encodePacked(m, th, nonce, count))) >> (256 - d) == 0;
    }

    /// Mine for a wallet at mint count `count`. Every caller below mines for a
    /// wallet that has NOT successfully minted the tick yet → count 0.
    function _mine(address m, bytes32 th, uint64 count) internal pure returns (uint256 n) {
        while (!_satisfies(m, th, n, D, count)) n++;
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

    // ---- deploy ----

    function test_DeployTickStoresConfig() public view {
        (
            address dep,
            uint64 maxM,
            uint64 total,
            uint32 wlim,
            uint128 apm,
            uint8 d,
            uint32 epochMints,
            uint32 epochTarget,
            uint32 epochMinted,
            uint64 epochStart
        ) = hub.ticks(ROBIN);
        assertEq(dep, deployer);
        assertEq(maxM, 21_000);
        assertEq(total, 0);
        assertEq(wlim, 10);
        assertEq(apm, 1000);
        assertEq(d, D);
        assertEq(epochMints, 21_000);
        assertEq(epochTarget, 600);
        assertEq(epochMinted, 0);
        assertEq(epochStart, 1);
    }

    function test_DeployEmitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit InscriptionHub.Deployed(keccak256("free"), bob, "free", 100, 5, 2, D, 100, 60);
        vm.prank(bob);
        hub.deployTick("free", 100, 5, 2, D, 100, 60);
    }

    function test_RevertWhen_TickDuplicate() public {
        vm.expectRevert(InscriptionHub.TickExists.selector);
        hub.deployTick("robin", 1, 1, 1, 1, 1, 1);
    }

    function test_RevertWhen_TickMalformed() public {
        vm.expectRevert(InscriptionHub.BadTick.selector);
        hub.deployTick("Robin", 1, 1, 1, 1, 1, 1); // uppercase
        vm.expectRevert(InscriptionHub.BadTick.selector);
        hub.deployTick("ninechars", 1, 1, 1, 1, 1, 1); // 9 chars
        vm.expectRevert(InscriptionHub.BadTick.selector);
        hub.deployTick("", 1, 1, 1, 1, 1, 1);
        vm.expectRevert(InscriptionHub.BadTick.selector);
        hub.deployTick("ro bin", 1, 1, 1, 1, 1, 1); // space
        vm.expectRevert(InscriptionHub.BadTick.selector);
        hub.deployTick(unicode"röbin", 1, 1, 1, 1, 1, 1); // non-ascii
    }

    function test_RevertWhen_ParamsOutOfRange() public {
        vm.startPrank(deployer);
        vm.expectRevert(InscriptionHub.BadParams.selector);
        hub.deployTick("a", 0, 1, 1, 1, 1, 1); // maxMints 0
        vm.expectRevert(InscriptionHub.BadParams.selector);
        hub.deployTick("a", 1e9 + 1, 1, 1, 1, 1, 1);
        vm.expectRevert(InscriptionHub.BadParams.selector);
        hub.deployTick("a", 100, 0, 1, 1, 1, 1); // amountPerMint 0
        vm.expectRevert(InscriptionHub.BadParams.selector);
        hub.deployTick("a", 100, 1e15 + 1, 1, 1, 1, 1);
        vm.expectRevert(InscriptionHub.BadParams.selector);
        hub.deployTick("a", 100, 1, 0, 1, 1, 1); // walletLimit 0
        vm.expectRevert(InscriptionHub.BadParams.selector);
        hub.deployTick("a", 100, 1, 101, 1, 1, 1); // walletLimit > maxMints
        vm.expectRevert(InscriptionHub.BadParams.selector);
        hub.deployTick("a", 100, 1, 1, 0, 1, 1); // difficulty 0
        vm.expectRevert(InscriptionHub.BadParams.selector);
        hub.deployTick("a", 100, 1, 1, 121, 1, 1); // difficulty > MAX (120)
        vm.expectRevert(InscriptionHub.BadParams.selector);
        hub.deployTick("a", 100, 1, 1, 1, 0, 1); // epochMints 0
        vm.expectRevert(InscriptionHub.BadParams.selector);
        hub.deployTick("a", 100, 1, 1, 1, 101, 1); // epochMints > maxMints
        vm.expectRevert(InscriptionHub.BadParams.selector);
        hub.deployTick("a", 100, 1, 1, 1, 1, 0); // epochTargetSeconds 0
        vm.expectRevert(InscriptionHub.BadParams.selector);
        hub.deployTick("a", 100, 1, 1, 1, 1, 365 days + 1);
        vm.stopPrank();
    }

    function test_AnyoneCanDeployTicks() public {
        vm.prank(alice);
        hub.deployTick("free", 100, 5, 2, 8, 100, 60);
        (address dep,,,,,, uint32 epochMints,,,) = hub.ticks(keccak256("free"));
        assertEq(dep, alice);
        assertEq(epochMints, 100);
    }

    // ---- mint: shape, payment, access ----

    function test_MintHappyPath() public {
        vm.expectEmit(true, true, false, true);
        emit InscriptionHub.Inscribed(ROBIN, alice, 1);
        (bool ok,) = _mint(alice, _powText("robin", "1000", _mine(alice, ROBIN, 0)));
        assertTrue(ok);

        (,, uint64 total,,,,,,,) = hub.ticks(ROBIN);
        assertEq(total, 1);
        assertEq(hub.mintsOf(ROBIN, alice), 1);
    }

    function test_RevertWhen_UnknownTick() public {
        (bool ok, bytes memory ret) = _mint(alice, _powText("nope", "1", _mine(alice, keccak256("nope"), 0)));
        assertFalse(ok);
        assertEq(bytes4(ret), InscriptionHub.UnknownTick.selector);
    }

    function test_RevertWhen_AmtMismatchesConfig() public {
        (bool ok, bytes memory ret) = _mint(alice, _powText("robin", "999", _mine(alice, ROBIN, 0)));
        assertFalse(ok);
        assertEq(bytes4(ret), InscriptionHub.BadInscription.selector);
    }

    function test_RevertWhen_WrongValue() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice, alice);
        (bool okLow, bytes memory retLow) =
            address(hub).call{value: 1 wei}(_powText("robin", "1000", _mine(alice, ROBIN, 0)));
        assertFalse(okLow);
        assertEq(bytes4(retLow), InscriptionHub.WrongPayment.selector);
    }

    function test_RevertWhen_TextNotCanonical() public {
        bytes[] memory bad = new bytes[](7);
        bad[0] = bytes('data:,{"p":"arc-20","op":"mint","tick":"robin","amt":"1000","nonce":"1"} '); // trailing
        bad[1] = bytes('data:,{"p":"arc-20","op":"mint","tick":"robin","amt":"01000","nonce":"1"}'); // leading zero amt
        bad[2] = bytes('data:,{"p":"arc-20","op":"mint","tick":"ROBIN","amt":"1000","nonce":"1"}'); // uppercase tick
        bad[3] = bytes('data:,{"p":"arc-20","op":"mint","tick":"robin","amt":"","nonce":"1"}'); // empty amt
        bad[4] = bytes('data:,{"p":"arc-20","op":"mint","tick":"robin","amt":"1000"}'); // missing nonce
        bad[5] = bytes('data:,{ "p":"arc-20","op":"mint","tick":"robin","amt":"1000","nonce":"1"}'); // space
        bad[6] = bytes('data:,{"p":"arc-20","op":"mint","tick":"robin","amt":"1000","nonce":"01"}'); // leading zero nonce

        for (uint256 i = 0; i < bad.length; i++) {
            vm.prank(alice, alice);
            (bool ok, bytes memory ret) = address(hub).call(bad[i]);
            assertFalse(ok, string(abi.encodePacked("case ", vm.toString(i))));
            assertEq(bytes4(ret), InscriptionHub.BadInscription.selector);
        }
        (,, uint64 total,,,,,,,) = hub.ticks(ROBIN);
        assertEq(total, 0);
        assertEq(address(hub).balance, 0);
    }

    function test_RevertWhen_CallerIsContract() public {
        MintProxy proxy = new MintProxy();
        vm.prank(alice, alice);
        vm.expectRevert(InscriptionHub.ContractCallerNotAllowed.selector);
        proxy.tryMint(hub, _powText("robin", "1000", _mine(alice, ROBIN, 0)));
    }

    // ---- fuzz ----

    function testFuzz_NonCanonicalCalldataNeverMints(bytes calldata data) public {
        vm.assume(keccak256(data) != keccak256(_powText("robin", "1000", _mine(alice, ROBIN, 0))));
        vm.prank(alice, alice);
        address(hub).call(data);
        (,, uint64 total,,,,,,,) = hub.ticks(ROBIN);
        assertEq(total, 0);
        assertEq(address(hub).balance, 0);
    }

    function testFuzz_MintOnlyWithZeroValue(uint256 value) public {
        value = bound(value, 1, 1 ether);
        vm.deal(alice, 10 ether);
        vm.prank(alice, alice);
        (bool ok,) = address(hub).call{value: value}(_powText("robin", "1000", _mine(alice, ROBIN, 0)));
        assertFalse(ok);
    }
}
