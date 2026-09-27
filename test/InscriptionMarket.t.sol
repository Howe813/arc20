// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {InscriptionMarket} from "../src/InscriptionMarket.sol";

contract RevertingSeller {
    function list(InscriptionMarket market, bytes calldata data) external {
        (bool ok,) = address(market).call(data);
        require(ok, "list failed");
    }

    receive() external payable {
        revert("no thanks");
    }
}

/// Seller that tries to reenter the market when it receives its sale proceeds.
contract ReentrantSeller {
    InscriptionMarket public market;
    uint256[] public reenterIds;
    bool public reenterTried;
    bool public reenterSucceeded;

    constructor(InscriptionMarket m) {
        market = m;
    }

    function list(bytes calldata data) external {
        (bool ok,) = address(market).call(data);
        require(ok, "list failed");
    }

    function setReenter(uint256[] calldata ids) external {
        reenterIds = ids;
    }

    receive() external payable {
        if (reenterIds.length == 0) return;
        reenterTried = true;
        // Attempt to reenter sweep during the payout — the guard must block it.
        try market.sweep{value: address(this).balance}(reenterIds) {
            reenterSucceeded = true;
        } catch {
            reenterSucceeded = false;
        }
    }
}

/// Buyer contract that refuses ETH — its sweep refund must fail the whole tx.
contract RejectingBuyer {
    function sweep(InscriptionMarket market, uint256[] calldata ids) external payable {
        market.sweep{value: msg.value}(ids);
    }

    receive() external payable {
        revert("reject");
    }
}

/// Receiver that rejects ETH while `blocked`, then accepts — to exercise the
/// pendingProceeds -> claimProceeds path (credited at buy time, claimed later).
contract ToggleReceiver {
    InscriptionMarket public market;
    bool public blocked = true;
    uint256 public myBid;

    constructor(InscriptionMarket m) {
        market = m;
    }

    function unblock() external {
        blocked = false;
    }

    function placeBid(uint128 price) external payable {
        myBid = market.placeBid{value: msg.value}("robin", 1000, price);
    }

    function doCancel() external {
        market.cancelBid(myBid);
    }

    function listVia(bytes calldata d) external {
        (bool ok,) = address(market).call(d);
        require(ok, "list failed");
    }

    function claim() external {
        market.claimProceeds();
    }

    receive() external payable {
        if (blocked) revert("blocked");
    }
}

/// Bidder that tries to reenter cancelBid when it receives its refund.
contract ReentrantBidder {
    InscriptionMarket public market;
    uint256 public myBid;
    bool public tried;
    uint256 public got;

    constructor(InscriptionMarket m) {
        market = m;
    }

    function place(uint128 price) external payable {
        myBid = market.placeBid{value: msg.value}("robin", 1000, price);
    }

    function doCancel() external {
        market.cancelBid(myBid);
    }

    receive() external payable {
        got += msg.value;
        if (!tried) {
            tried = true;
            try market.cancelBid(myBid) {} catch {} // reentry must be blocked
        }
    }
}

contract InscriptionMarketTest is Test {
    InscriptionMarket market;
    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address seller = makeAddr("seller");
    address buyer = makeAddr("buyer");
    address other = makeAddr("other"); // third party: never bidder nor seller

    bytes constant LIST_500_ROBIN =
        'data:,{"p":"arc-20","op":"list","tick":"robin","amt":"500","price":"50000000000000000"}';
    uint256 constant PRICE = 0.05 ether;
    uint256 constant FEE = PRICE * 500 / 10000; // 0.0025 ether per side

    function setUp() public {
        market = new InscriptionMarket(owner, operator);
        vm.deal(buyer, 10 ether);
    }

    function _list(address who, bytes memory data) internal returns (bool ok) {
        vm.prank(who);
        (ok,) = address(market).call(data);
    }

    // ---- list ----

    function test_ListCreatesPendingListing() public {
        vm.expectEmit(true, true, true, true);
        emit InscriptionMarket.Listed(1, seller, keccak256("robin"), "robin", 500, PRICE);
        assertTrue(_list(seller, LIST_500_ROBIN));

        (address s, bytes32 th, uint128 amt, uint128 price, InscriptionMarket.Status st) = market.listings(1);
        assertEq(s, seller);
        assertEq(th, keccak256("robin"));
        assertEq(amt, 500);
        assertEq(price, PRICE);
        assertEq(uint8(st), uint8(InscriptionMarket.Status.Pending));
        assertEq(market.nextId(), 2);
    }

    function test_RevertWhen_ListingCarriesValue() public {
        vm.deal(seller, 1 ether);
        vm.prank(seller);
        (bool ok, bytes memory ret) = address(market).call{value: 1 wei}(LIST_500_ROBIN);
        assertFalse(ok);
        assertEq(bytes4(ret), InscriptionMarket.WrongPayment.selector);
    }

    function test_RevertWhen_ListTextNotCanonical() public {
        bytes[] memory bad = new bytes[](6);
        bad[0] = bytes('data:,{"p":"arc-20","op":"mint","tick":"robin","amt":"1000"}'); // mint op
        bad[1] = bytes('data:,{"p":"arc-20","op":"list","tick":"robin","amt":"0500","price":"1"}'); // leading zero amt
        bad[2] = bytes('data:,{"p":"arc-20","op":"list","tick":"robin","amt":"500","price":"0"}'); // zero price
        bad[3] = bytes('data:,{"p":"arc-20","op":"list","tick":"robin","amt":"500","price":"01"}'); // leading zero price
        bad[4] = bytes('data:,{"p":"arc-20","op":"list","tick":"robin","amt":"500","price":"1"} '); // trailing byte
        bad[5] = bytes("");

        for (uint256 i = 0; i < bad.length; i++) {
            vm.prank(seller);
            (bool ok, bytes memory ret) = address(market).call(bad[i]);
            assertFalse(ok, string(abi.encodePacked("case ", vm.toString(i))));
            assertEq(bytes4(ret), InscriptionMarket.BadInscription.selector);
        }
        assertEq(market.nextId(), 1);
    }

    // ---- confirm ----

    function test_ConfirmOnlyOperator() public {
        _list(seller, LIST_500_ROBIN);

        vm.prank(seller);
        vm.expectRevert(InscriptionMarket.NotOperator.selector);
        market.confirm(1);

        vm.prank(operator);
        market.confirm(1);
        (,,,, InscriptionMarket.Status st) = market.listings(1);
        assertEq(uint8(st), uint8(InscriptionMarket.Status.Active));

        vm.prank(operator);
        vm.expectRevert(InscriptionMarket.BadState.selector);
        market.confirm(1); // already Active
    }

    // ---- buy ----

    function test_BuyPaysSellerAndAccruesFees() public {
        _list(seller, LIST_500_ROBIN);
        vm.prank(operator);
        market.confirm(1);

        vm.prank(buyer);
        vm.expectEmit(true, true, false, false);
        emit InscriptionMarket.Bought(1, buyer);
        market.buy{value: PRICE + FEE}(1);

        assertEq(seller.balance, PRICE - FEE, "seller receives price - 5%");
        assertEq(market.accruedFees(), 2 * FEE, "platform gets both sides");
        assertEq(address(market).balance, 2 * FEE, "no dust stuck");
        (,,,, InscriptionMarket.Status st) = market.listings(1);
        assertEq(uint8(st), uint8(InscriptionMarket.Status.Sold));
    }

    function test_FeeRoundingConservation() public {
        // odd price: 33 wei -> fee floor(1.65) = 1; buyer pays 34, seller gets 32, platform 2
        assertTrue(_list(seller, 'data:,{"p":"arc-20","op":"list","tick":"robin","amt":"1","price":"33"}'));
        vm.prank(operator);
        market.confirm(1);

        vm.prank(buyer);
        market.buy{value: 34}(1);
        assertEq(seller.balance, 32);
        assertEq(market.accruedFees(), 2);
        assertEq(address(market).balance, 2);
    }

    function test_RevertWhen_BuyWrongValueOrState() public {
        _list(seller, LIST_500_ROBIN);

        vm.prank(buyer);
        vm.expectRevert(InscriptionMarket.BadState.selector);
        market.buy{value: PRICE + FEE}(1); // still Pending

        vm.prank(operator);
        market.confirm(1);

        vm.prank(buyer);
        vm.expectRevert(InscriptionMarket.WrongPayment.selector);
        market.buy{value: PRICE}(1); // missing buyer fee

        vm.prank(buyer);
        market.buy{value: PRICE + FEE}(1);

        vm.prank(buyer);
        vm.expectRevert(InscriptionMarket.BadState.selector);
        market.buy{value: PRICE + FEE}(1); // already Sold
    }

    function test_BuyFromRevertingSellerCreditsPendingProceeds() public {
        RevertingSeller rs = new RevertingSeller();
        rs.list(market, LIST_500_ROBIN);
        vm.prank(operator);
        market.confirm(1);

        vm.prank(buyer);
        market.buy{value: PRICE + FEE}(1); // seller payout fails -> credited

        assertEq(market.pendingProceeds(address(rs)), PRICE - FEE);
        assertEq(address(market).balance, PRICE + FEE); // proceeds parked + fees
    }

    // ---- cancel ----

    function test_CancelBySellerFromPendingOrActive() public {
        _list(seller, LIST_500_ROBIN);
        vm.prank(seller);
        market.cancel(1);
        (,,,, InscriptionMarket.Status st) = market.listings(1);
        assertEq(uint8(st), uint8(InscriptionMarket.Status.Cancelled));

        _list(seller, LIST_500_ROBIN); // id 2
        vm.prank(operator);
        market.confirm(2);
        vm.prank(seller);
        market.cancel(2);

        vm.prank(buyer);
        vm.expectRevert(InscriptionMarket.BadState.selector);
        market.buy{value: PRICE + FEE}(2);
    }

    function test_RevertWhen_CancelNotSellerOrSold() public {
        _list(seller, LIST_500_ROBIN);
        vm.prank(buyer);
        vm.expectRevert(InscriptionMarket.NotSeller.selector);
        market.cancel(1);

        vm.prank(operator);
        market.confirm(1);
        vm.prank(buyer);
        market.buy{value: PRICE + FEE}(1);

        vm.prank(seller);
        vm.expectRevert(InscriptionMarket.BadState.selector);
        market.cancel(1); // Sold is final
    }

    // ---- admin ----

    function test_WithdrawFeesOnlyOwnerAndOnlyAccrued() public {
        RevertingSeller rs = new RevertingSeller();
        rs.list(market, LIST_500_ROBIN);
        vm.prank(operator);
        market.confirm(1);
        vm.prank(buyer);
        market.buy{value: PRICE + FEE}(1); // parks seller proceeds in the contract

        vm.prank(seller);
        vm.expectRevert();
        market.withdrawFees(payable(seller));

        address payable treasury = payable(makeAddr("treasury"));
        vm.prank(owner);
        market.withdrawFees(treasury);
        assertEq(treasury.balance, 2 * FEE, "owner can only take fees, not parked proceeds");
        assertEq(address(market).balance, PRICE - FEE, "seller's pending proceeds untouched");

        vm.prank(owner);
        vm.expectRevert(InscriptionMarket.ZeroAddress.selector);
        market.withdrawFees(payable(address(0)));
    }

    function test_SetOperator() public {
        address newOp = makeAddr("newOp");
        vm.prank(owner);
        market.setOperator(newOp);
        assertEq(market.operator(), newOp);

        vm.prank(operator);
        vm.expectRevert();
        market.setOperator(operator); // old operator is not owner

        vm.prank(owner);
        vm.expectRevert(InscriptionMarket.ZeroAddress.selector);
        market.setOperator(address(0));
    }

    // ---- sweep ----

    function _listCustom(address who, uint256 amt, uint256 price) internal {
        bytes memory data = bytes(
            string.concat(
                'data:,{"p":"arc-20","op":"list","tick":"robin","amt":"',
                vm.toString(amt),
                '","price":"',
                vm.toString(price),
                '"}'
            )
        );
        require(_list(who, data), "list failed");
    }

    function _confirm(uint256 id) internal {
        vm.prank(operator);
        market.confirm(id);
    }

    function test_SweepBuysMultipleAndRefundsZero() public {
        _listCustom(seller, 500, 0.05 ether); // id1
        _listCustom(seller, 300, 0.04 ether); // id2
        _confirm(1);
        _confirm(2);

        uint256 fee1 = 0.05 ether * 500 / 10000;
        uint256 fee2 = 0.04 ether * 500 / 10000;
        uint256 pay = (0.05 ether + fee1) + (0.04 ether + fee2);

        uint256[] memory ids = new uint256[](2);
        ids[0] = 2; // cheapest first
        ids[1] = 1;
        vm.prank(buyer);
        market.sweep{value: pay}(ids);

        (,,,, InscriptionMarket.Status s1) = market.listings(1);
        (,,,, InscriptionMarket.Status s2) = market.listings(2);
        assertEq(uint8(s1), uint8(InscriptionMarket.Status.Sold));
        assertEq(uint8(s2), uint8(InscriptionMarket.Status.Sold));
        assertEq(seller.balance, (0.05 ether - fee1) + (0.04 ether - fee2));
        assertEq(market.accruedFees(), 2 * fee1 + 2 * fee2);
        assertEq(address(market).balance, 2 * fee1 + 2 * fee2, "no dust stuck");
    }

    function test_SweepSkipsTakenAndRefunds() public {
        _listCustom(seller, 500, 0.05 ether); // id1
        _listCustom(seller, 300, 0.04 ether); // id2
        _confirm(1);
        _confirm(2);

        // someone buys id1 before the sweep lands
        vm.prank(buyer);
        market.buy{value: 0.05 ether + FEE}(1);

        uint256 fee2 = 0.04 ether * 500 / 10000;
        uint256 pay = (0.05 ether + FEE) + (0.04 ether + fee2); // budget for both
        uint256[] memory ids = new uint256[](2);
        ids[0] = 1; // already Sold — must be skipped
        ids[1] = 2;
        uint256 balBefore = buyer.balance;
        vm.prank(buyer);
        market.sweep{value: pay}(ids);

        uint256 spent2 = 0.04 ether + fee2;
        assertEq(buyer.balance, balBefore - spent2, "only spent for id2, rest refunded");
        (,,,, InscriptionMarket.Status s2) = market.listings(2);
        assertEq(uint8(s2), uint8(InscriptionMarket.Status.Sold));
    }

    function test_SweepRespectsBudget() public {
        _listCustom(seller, 500, 0.05 ether); // id1
        _listCustom(seller, 500, 0.05 ether); // id2
        _confirm(1);
        _confirm(2);

        uint256 one = 0.05 ether + FEE; // budget for a single lot
        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 2;
        vm.prank(buyer);
        market.sweep{value: one}(ids);

        (,,,, InscriptionMarket.Status s1) = market.listings(1);
        (,,,, InscriptionMarket.Status s2) = market.listings(2);
        assertEq(uint8(s1), uint8(InscriptionMarket.Status.Sold));
        assertEq(uint8(s2), uint8(InscriptionMarket.Status.Active), "second lot unaffordable, left active");
        assertEq(address(market).balance, 2 * FEE, "only fees retained; no refund dust");
    }

    function test_RevertWhen_SweepBadLength() public {
        uint256[] memory empty = new uint256[](0);
        vm.prank(buyer);
        vm.expectRevert(InscriptionMarket.BadSweepLength.selector);
        market.sweep{value: 0}(empty);

        uint256[] memory tooMany = new uint256[](51);
        vm.prank(buyer);
        vm.expectRevert(InscriptionMarket.BadSweepLength.selector);
        market.sweep{value: 0}(tooMany);
    }

    function test_RevertWhen_SweepNothingBought() public {
        _listCustom(seller, 500, 0.05 ether); // id1
        _confirm(1);
        vm.prank(seller);
        market.cancel(1);

        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        vm.prank(buyer);
        vm.expectRevert(InscriptionMarket.NothingBought.selector);
        market.sweep{value: 0.05 ether + FEE}(ids);
    }

    function test_SweepRevertingSellerCreditsProceeds() public {
        RevertingSeller rs = new RevertingSeller();
        rs.list(market, LIST_500_ROBIN); // id1, seller = rs
        _confirm(1);

        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        vm.prank(buyer);
        market.sweep{value: PRICE + FEE}(ids);

        assertEq(market.pendingProceeds(address(rs)), PRICE - FEE);
        (,,,, InscriptionMarket.Status s1) = market.listings(1);
        assertEq(uint8(s1), uint8(InscriptionMarket.Status.Sold));
    }

    // ---- sweep: user's exact scenario (5 lots, 1 front-run, 4 must succeed) ----

    function test_SweepFiveLotsOneFrontRunFourSucceed() public {
        // 5 listings from `seller`, all confirmed
        uint256[] memory prices = new uint256[](5);
        prices[0] = 0.01 ether;
        prices[1] = 0.02 ether;
        prices[2] = 0.03 ether;
        prices[3] = 0.04 ether;
        prices[4] = 0.05 ether;
        for (uint256 i = 0; i < 5; i++) {
            _listCustom(seller, 1000, prices[i]);
            _confirm(i + 1);
        }

        // someone else front-runs and buys listing #3 (0.03) before the sweep lands
        address frontRunner = makeAddr("frontRunner");
        uint256 fee3 = 0.03 ether * 500 / 10000;
        vm.deal(frontRunner, 1 ether);
        vm.prank(frontRunner);
        market.buy{value: 0.03 ether + fee3}(3);

        // sweeper sweeps ALL five ids, funding the full 5-lot total
        uint256 total;
        for (uint256 i = 0; i < 5; i++) {
            total += prices[i] + (prices[i] * 500 / 10000);
        }
        address sweeper = makeAddr("sweeper");
        vm.deal(sweeper, total);

        uint256[] memory ids = new uint256[](5);
        for (uint256 i = 0; i < 5; i++) {
            ids[i] = i + 1;
        }

        uint256 before = sweeper.balance;
        vm.prank(sweeper);
        market.sweep{value: total}(ids);

        // the 4 remaining lots (1,2,4,5) are now Sold; #3 was taken by the front-runner
        for (uint256 i = 1; i <= 5; i++) {
            (,,,, InscriptionMarket.Status st) = market.listings(i);
            assertEq(
                uint8(st), uint8(InscriptionMarket.Status.Sold), "every lot sold (4 by sweeper, #3 by front-runner)"
            );
        }
        // sweeper paid ONLY for the 4 it got; #3's portion was refunded
        uint256 cost3 = 0.03 ether + fee3;
        uint256 spentBySweeper = before - sweeper.balance;
        assertEq(spentBySweeper, total - cost3, "sweeper charged for 4 lots, refunded the front-run one");
    }

    // ---- claimProceeds ----

    function test_ClaimProceedsAfterFailedPayout() public {
        ToggleReceiver rc = new ToggleReceiver(market);
        rc.listVia(LIST_500_ROBIN); // seller = rc
        _confirm(1);
        vm.prank(buyer);
        market.buy{value: PRICE + FEE}(1); // payout to rc fails (blocked) -> parked
        assertEq(market.pendingProceeds(address(rc)), PRICE - FEE);

        rc.unblock();
        rc.claim();
        assertEq(address(rc).balance, PRICE - FEE, "claimed exactly the parked proceeds");
        assertEq(market.pendingProceeds(address(rc)), 0);
    }

    function test_RevertWhen_ClaimNothing() public {
        vm.prank(seller);
        vm.expectRevert(InscriptionMarket.NothingToClaim.selector);
        market.claimProceeds();
    }

    // ---- sweep: adversarial ----

    function test_SweepReentrantSellerCannotExploit() public {
        // reentrant seller lists a lot; a second normal lot exists too
        ReentrantSeller rs = new ReentrantSeller(market);
        rs.list(LIST_500_ROBIN); // id1, seller = rs
        _listCustom(seller, 300, 0.04 ether); // id2
        _confirm(1);
        _confirm(2);

        // rs will try to reenter sweep([2]) when it receives id1's proceeds
        uint256[] memory reenter = new uint256[](1);
        reenter[0] = 2;
        rs.setReenter(reenter);

        uint256 fee2 = 0.04 ether * 500 / 10000;
        uint256 pay = (PRICE + FEE) + (0.04 ether + fee2);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 2;
        vm.prank(buyer);
        market.sweep{value: pay}(ids);

        // The reentry was attempted and MUST have been blocked by the guard.
        // (The seller catches the blocked call, so its own payout still succeeds
        // and it is paid directly — the point is the reentrant sweep did NOT run,
        // so id2 could not be double-bought.)
        assertTrue(rs.reenterTried(), "seller attempted reentry");
        assertFalse(rs.reenterSucceeded(), "reentry must be blocked");
        (,,,, InscriptionMarket.Status s2) = market.listings(2);
        assertEq(uint8(s2), uint8(InscriptionMarket.Status.Sold), "id2 bought by the real buyer");
        // id2 sold exactly once → the plain seller got its proceeds exactly once
        assertEq(seller.balance, 0.04 ether - fee2, "id2 proceeds paid once");
        assertEq(address(rs).balance, PRICE - FEE, "rs paid its id1 proceeds once, directly");
        // conservation: contract retains only fees (nothing parked, no dust)
        assertEq(address(market).balance, market.accruedFees(), "only fees retained");
    }

    // ---- on-chain accept binding (consensus v4: settleBid pays the bound seller only) ----

    function test_CancelManyMixed() public {
        _listCustom(seller, 500, 0.05 ether); // id 1 — seller's, stays Open
        _listCustom(seller, 500, 0.05 ether); // id 2 — cancelled before the batch
        vm.prank(seller);
        market.cancel(2);
        _listCustom(buyer, 500, 0.05 ether); // id 3 — someone else's order

        uint256[] memory ids = new uint256[](3);
        ids[0] = 1;
        ids[1] = 2;
        ids[2] = 3;
        vm.prank(seller);
        uint256 n = market.cancelMany(ids);
        assertEq(n, 1, "skip-any: only the caller's open listing is cancelled");
        (,,,, InscriptionMarket.Status s1) = market.listings(1);
        assertEq(uint8(s1), uint8(InscriptionMarket.Status.Cancelled), "own open listing cancelled");
        (,,,, InscriptionMarket.Status s3) = market.listings(3);
        assertEq(uint8(s3), uint8(InscriptionMarket.Status.Pending), "foreign listing untouched");
    }

    function test_CancelManySkipsIneligible() public {
        _listCustom(buyer, 500, 0.05 ether); // id 1 — belongs to the buyer
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        vm.prank(seller);
        assertEq(market.cancelMany(ids), 0, "foreign-only batch cancels nothing");
        (,,,, InscriptionMarket.Status st) = market.listings(1);
        assertEq(uint8(st), uint8(InscriptionMarket.Status.Pending), "status unchanged");
        // empty batch: pure no-op, returns 0
        uint256[] memory none = new uint256[](0);
        vm.prank(seller);
        assertEq(market.cancelMany(none), 0, "empty batch is a no-op");
    }

    function test_CancelManyWithUnknownIds() public {
        // unknown ids map to a zeroed Listing (seller == 0) → skipped, no revert
        _listCustom(seller, 500, 0.05 ether); // id 1
        uint256[] memory ids = new uint256[](2);
        ids[0] = 999;
        ids[1] = 1;
        vm.prank(seller);
        assertEq(market.cancelMany(ids), 1, "unknown ids skipped, own listing cancelled");
    }

    function test_CancelBidRefundGoesToPending() public {
        // a bidder contract that refuses ETH must still be able to cancel
        ToggleReceiver tr = new ToggleReceiver(market);
        tr.placeBid{value: BID_ESCROW}(uint128(BID_PRICE));
        // refusing bidder cancels: refund is parked, the cancel does NOT revert
        tr.doCancel();
        assertEq(market.pendingProceeds(address(tr)), BID_ESCROW, "refund parked as pending");
        assertEq(address(market).balance, BID_ESCROW, "funds still held (now as pending)");
        // once the bidder accepts ETH, claimProceeds releases it — no funds stuck
        tr.unblock();
        tr.claim();
        assertEq(address(tr).balance, BID_ESCROW, "refusing bidder recovered via claimProceeds");
        assertEq(address(market).balance, 0, "no funds stuck");
    }

    function test_SweepBuyerRefundGoesToPending() public {
        _listCustom(seller, 500, 0.05 ether); // id1
        _confirm(1);
        RejectingBuyer rb = new RejectingBuyer();
        vm.deal(address(rb), 1 ether);

        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        // overpay so a refund is owed; buyer rejects it → refund is parked as
        // a pending credit and the sweep SUCCEEDS (listings sold, seller paid)
        rb.sweep{value: 1 ether}(market, ids);
        (,,,, InscriptionMarket.Status s1) = market.listings(1);
        assertEq(uint8(s1), uint8(InscriptionMarket.Status.Sold), "sweep succeeds despite refused refund");
        uint256 owed = 1 ether - (0.05 ether + 0.0025 ether);
        assertEq(market.pendingProceeds(address(rb)), owed, "overpay parked as pending refund");
        // conservation: contract holds fees + the parked refund, nothing lost
        assertEq(address(market).balance, market.accruedFees() + market.pendingProceeds(address(rb)), "funds conserved");
    }

    // ---- R18 boundary gaps ----

    function test_RevertWhen_BuyOverpays() public {
        _listCustom(seller, 500, 0.05 ether); // id 1
        _confirm(1);
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(InscriptionMarket.WrongPayment.selector);
        market.buy{value: PRICE + FEE + 1}(1); // even 1 wei of overpay must revert
    }

    function test_SweepAtExactlyMaxSweepIds() public {
        // exactly MAX_SWEEP (50) ids is legal; duplicate ids of one listing are
        // charged once, so one open listing covers the whole batch
        _listCustom(seller, 500, 0.05 ether); // id 1
        _confirm(1);
        uint256[] memory ids = new uint256[](50);
        for (uint256 i = 0; i < 50; i++) {
            ids[i] = 1;
        }
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        market.sweep{value: PRICE + FEE}(ids);
        (,,,, InscriptionMarket.Status st) = market.listings(1);
        assertEq(uint8(st), uint8(InscriptionMarket.Status.Sold), "50-id batch accepted and fully bought");
    }

    function test_RevertWhen_SweepExceedsMaxSweepIds() public {
        _listCustom(seller, 500, 0.05 ether); // id 1
        uint256[] memory ids = new uint256[](51);
        for (uint256 i = 0; i < 51; i++) {
            ids[i] = 1;
        }
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(InscriptionMarket.BadSweepLength.selector);
        market.sweep{value: 1 ether}(ids);
    }

    function test_ParseListPriceDigitBounds() public {
        // 30 digits (≈1e29 < 2^128) parses and creates the listing; 31 digits
        // breach the digit cap → BadInscription; a 39-digit uint128-overflowing
        // value never reaches the uint128 check — the digit cap fires first.
        vm.prank(buyer, buyer);
        (bool ok30,) = address(market).call(_listData("500", "100000000000000000000000000000"));
        assertTrue(ok30, "30-digit price parses");
        vm.prank(buyer, buyer);
        (bool ok31,) = address(market).call(_listData("500", "1000000000000000000000000000000"));
        assertFalse(ok31, "31-digit price rejected");
        vm.prank(buyer, buyer);
        (bool ok39,) = address(market).call(_listData("500", "340282366920938463463374607431768211456"));
        assertFalse(ok39, "39-digit price rejected");
    }

    /// Raw list calldata with explicit amt/price strings (for digit-bound cases).
    function _listData(string memory amt, string memory price) internal pure returns (bytes memory) {
        return
            bytes(
                string.concat('data:,{"p":"arc-20","op":"list","tick":"robin","amt":"', amt, '","price":"', price, '"}')
            );
    }

    function test_SweepDuplicateIdsChargedOnce() public {
        _listCustom(seller, 500, 0.05 ether); // id1
        _confirm(1);
        uint256[] memory ids = new uint256[](3);
        ids[0] = 1;
        ids[1] = 1; // duplicates
        ids[2] = 1;
        uint256 balBefore = buyer.balance;
        vm.prank(buyer);
        market.sweep{value: 3 * (PRICE + FEE)}(ids);
        // charged for exactly one lot; the rest refunded
        assertEq(buyer.balance, balBefore - (PRICE + FEE), "duplicate ids buy once");
        assertEq(seller.balance, PRICE - FEE);
    }

    /// Invariant: after any sweep, the contract holds exactly fees + parked
    /// proceeds, and the buyer's net spend equals what the sold lots cost.
    function testFuzz_SweepConservation(uint256 nLots, uint256 budget, uint256 priceSeed) public {
        nLots = bound(nLots, 1, 8);
        uint256 basePrice = bound(priceSeed, 1, 0.2 ether);
        for (uint256 i = 0; i < nLots; i++) {
            _listCustom(seller, 100 + i, basePrice + i * 1e12);
            _confirm(i + 1);
        }
        budget = bound(budget, 0, 5 ether);
        vm.deal(buyer, budget);

        uint256[] memory ids = new uint256[](nLots);
        for (uint256 i = 0; i < nLots; i++) {
            ids[i] = i + 1;
        }

        uint256 buyerBefore = buyer.balance;
        uint256 sellerBefore = seller.balance;
        vm.prank(buyer);
        try market.sweep{value: budget}(ids) {
            uint256 spent = buyerBefore - buyer.balance;
            uint256 sellerGot = seller.balance - sellerBefore;
            uint256 fees = market.accruedFees();
            // every bought lot: buyer paid price+fee, seller got price-fee, fees += 2*fee
            // ⇒ spent == sellerGot + fees, and the contract retains only fees
            assertEq(spent, sellerGot + fees, "buyer spend = seller proceeds + fees");
            assertEq(address(market).balance, fees, "contract holds only fees");
            assertLe(spent, budget, "never spends over budget");
        } catch {
            // only valid revert reason is NothingBought (budget too small for any lot)
            assertEq(buyer.balance, buyerBefore, "revert leaves buyer whole");
        }
    }

    // ---- bids (buy orders) ----

    uint256 constant BID_PRICE = 0.03 ether;
    uint256 constant BID_FEE = BID_PRICE * 500 / 10000; // 0.0015
    uint256 constant BID_ESCROW = BID_PRICE + BID_FEE;

    function _placeBid(address who, uint256 value) internal returns (uint256 id) {
        vm.deal(who, value);
        vm.prank(who);
        return market.placeBid{value: value}("robin", 1000, uint128(BID_PRICE));
    }

    /// Bind a bid fill on-chain: the seller sends the canonical accept
    /// inscription to the market (consensus v4 delivery proof).
    function _accept(address who, uint256 bidId) internal returns (bool ok) {
        bytes memory data =
            bytes(string.concat('data:,{"p":"arc-20","op":"accept","tick":"robin","bid":"', vm.toString(bidId), '"}'));
        vm.prank(who, who);
        (ok,) = address(market).call(data);
    }

    function test_PlaceBidEscrowsAndEmits() public {
        vm.expectEmit(true, true, true, true);
        emit InscriptionMarket.BidPlaced(1, buyer, keccak256("robin"), "robin", 1000, BID_PRICE);
        uint256 id = _placeBid(buyer, BID_ESCROW);

        assertEq(id, 1);
        assertEq(market.nextBidId(), 2);
        assertEq(address(market).balance, BID_ESCROW, "escrow held");
        (address bidder, bytes32 th, uint128 amt, uint128 price,, InscriptionMarket.BidStatus st) = market.bids(1);
        assertEq(bidder, buyer);
        assertEq(th, keccak256("robin"));
        assertEq(amt, 1000);
        assertEq(price, uint128(BID_PRICE));
        assertEq(uint8(st), uint8(InscriptionMarket.BidStatus.Open));
    }

    function test_RevertWhen_PlaceBidBadInput() public {
        vm.deal(buyer, 1 ether);
        vm.startPrank(buyer);
        vm.expectRevert(InscriptionMarket.WrongPayment.selector);
        market.placeBid{value: BID_PRICE}("robin", 1000, uint128(BID_PRICE)); // missing fee
        vm.expectRevert(InscriptionMarket.BadTick.selector);
        market.placeBid{value: BID_ESCROW}("ROBIN", 1000, uint128(BID_PRICE)); // uppercase
        vm.expectRevert(InscriptionMarket.BadAmount.selector);
        market.placeBid{value: 0}("robin", 0, 0);
        vm.stopPrank();
    }

    function test_CancelBidRefundsBidder() public {
        _placeBid(buyer, BID_ESCROW);
        uint256 before = buyer.balance;
        vm.prank(buyer);
        market.cancelBid(1);
        assertEq(buyer.balance, before + BID_ESCROW, "full escrow refunded");
        assertEq(address(market).balance, 0);
        (,,,,, InscriptionMarket.BidStatus st) = market.bids(1);
        assertEq(uint8(st), uint8(InscriptionMarket.BidStatus.Cancelled));
    }

    function test_RevertWhen_CancelBidNotBidderOrNotOpen() public {
        _placeBid(buyer, BID_ESCROW);
        vm.prank(seller);
        vm.expectRevert(InscriptionMarket.NotBidder.selector);
        market.cancelBid(1);

        vm.prank(buyer);
        market.cancelBid(1);
        vm.prank(buyer);
        vm.expectRevert(InscriptionMarket.BadState.selector);
        market.cancelBid(1); // already cancelled
    }

    function test_SettleBidPaysSellerAndBooksFees() public {
        _placeBid(buyer, BID_ESCROW);
        assertTrue(_accept(seller, 1), "seller binds the fill on-chain");
        vm.expectEmit(true, true, false, false);
        emit InscriptionMarket.BidFilled(1, seller);
        vm.prank(operator);
        market.settleBid(1, seller);

        assertEq(seller.balance, BID_PRICE - BID_FEE, "seller gets price - 5%");
        assertEq(market.accruedFees(), 2 * BID_FEE, "both fees booked");
        assertEq(address(market).balance, 2 * BID_FEE, "only fees remain; escrow fully distributed");
        (,,,,, InscriptionMarket.BidStatus st) = market.bids(1);
        assertEq(uint8(st), uint8(InscriptionMarket.BidStatus.Filled));
    }

    function test_RevertWhen_SettleBidNotOperatorOrNotOpen() public {
        _placeBid(buyer, BID_ESCROW);
        assertTrue(_accept(seller, 1));
        vm.prank(seller);
        vm.expectRevert(InscriptionMarket.NotOperator.selector);
        market.settleBid(1, seller);

        vm.prank(operator);
        market.settleBid(1, seller);
        vm.prank(operator);
        vm.expectRevert(InscriptionMarket.BadState.selector);
        market.settleBid(1, seller); // already filled

        // a cancelled bid can't be settled
        _placeBid(buyer, BID_ESCROW); // id 2
        vm.prank(buyer);
        market.cancelBid(2);
        vm.prank(operator);
        vm.expectRevert(InscriptionMarket.BadState.selector);
        market.settleBid(2, seller);
    }

    function test_SettleBidRevertingSellerCredited() public {
        _placeBid(buyer, BID_ESCROW);
        RevertingSeller rs = new RevertingSeller();
        assertTrue(_accept(address(rs), 1));
        vm.prank(operator);
        market.settleBid(1, address(rs));
        assertEq(market.pendingProceeds(address(rs)), BID_PRICE - BID_FEE);
    }

    function test_CancelBidReentrantBidderRefundedOnce() public {
        ReentrantBidder rb = new ReentrantBidder(market);
        uint128 price = 0.03 ether;
        uint256 escrow = uint256(price) + (uint256(price) * 500) / 10000;
        vm.deal(address(rb), escrow);
        rb.place{value: escrow}(price);

        rb.doCancel();
        // reentry was attempted and blocked; the bidder was refunded exactly once
        assertTrue(rb.tried(), "bidder attempted reentry");
        assertEq(rb.got(), escrow, "refunded exactly the escrow, once");
        assertEq(address(market).balance, 0, "no funds stuck");
        (,,,,, InscriptionMarket.BidStatus st) = market.bids(rb.myBid());
        assertEq(uint8(st), uint8(InscriptionMarket.BidStatus.Cancelled));
    }

    function test_RevertWhen_CancelBidAfterFilled() public {
        _placeBid(buyer, BID_ESCROW);
        assertTrue(_accept(seller, 1));
        vm.prank(operator);
        market.settleBid(1, seller);
        // once filled, the buyer can't cancel (funds already went to the seller)
        vm.prank(buyer);
        vm.expectRevert(InscriptionMarket.BadState.selector);
        market.cancelBid(1);
    }

    function test_RevertWhen_SettleBidToZeroAddress() public {
        _placeBid(buyer, BID_ESCROW);
        vm.prank(operator);
        vm.expectRevert(InscriptionMarket.ZeroAddress.selector);
        market.settleBid(1, address(0));
    }

    function test_SettleBidCeiPreventsDoubleSettle() public {
        _placeBid(buyer, BID_ESCROW);
        assertTrue(_accept(seller, 1));
        vm.prank(operator);
        market.settleBid(1, seller);
        // status flips to Filled before payout (CEI) + nonReentrant → no second payout
        vm.prank(operator);
        vm.expectRevert(InscriptionMarket.BadState.selector);
        market.settleBid(1, seller);
        assertEq(seller.balance, BID_PRICE - BID_FEE, "seller paid exactly once");
    }

    // ---- on-chain accept binding (consensus v4: settleBid pays the bound seller only) ----

    function test_RevertWhen_SettleBidBeforeAccept() public {
        _placeBid(buyer, BID_ESCROW);
        // no accept inscription sent yet — the operator cannot pick a payee
        vm.prank(operator);
        vm.expectRevert(InscriptionMarket.NotPendingSeller.selector);
        market.settleBid(1, seller);
        (,,,, address pending,) = market.bids(1);
        assertEq(pending, address(0), "fill not bound");
    }

    function test_RevertWhen_SettleBidToNonPendingSeller() public {
        _placeBid(buyer, BID_ESCROW);
        assertTrue(_accept(seller, 1));
        // bound seller is `seller`; settling to anyone else reverts, even for the operator
        vm.prank(operator);
        vm.expectRevert(InscriptionMarket.NotPendingSeller.selector);
        market.settleBid(1, buyer);
        assertEq(address(market).balance, BID_ESCROW, "escrow untouched");
    }

    function test_AcceptBidBindingLifecycle() public {
        _placeBid(buyer, BID_ESCROW);
        // accept before settle reverts; wrong tick and unknown/closed bids revert
        bool okWrong = _acceptRaw(seller, "nope", 1);
        assertFalse(okWrong, "wrong tick must revert");
        vm.expectEmit(true, true, true, true);
        emit InscriptionMarket.BidAccepted(1, seller, keccak256("robin"));
        assertTrue(_accept(seller, 1), "first accept binds the fill");
        (,,,, address pending,) = market.bids(1);
        assertEq(pending, seller, "pendingSeller recorded on-chain");

        assertFalse(_accept(other, 1), "second accept is taken (first come, first served)");
        assertFalse(_accept(seller, 1), "re-accept by the same seller reverts too");

        vm.prank(operator);
        market.settleBid(1, seller); // bound seller settles fine
        assertEq(seller.balance, BID_PRICE - BID_FEE);
    }

    function test_RevertWhen_AcceptClosedOrUnknownBid() public {
        _placeBid(buyer, BID_ESCROW);
        vm.prank(buyer);
        market.cancelBid(1);
        assertFalse(_accept(seller, 1), "accepting a cancelled bid must revert");
        assertFalse(_accept(seller, 999), "accepting an unknown bid must revert");
    }

    /// Low-level accept with an explicit tick (for wrong-tick cases).
    function _acceptRaw(address who, string memory tick, uint256 bidId) internal returns (bool ok) {
        bytes memory data = bytes(
            string.concat('data:,{"p":"arc-20","op":"accept","tick":"', tick, '","bid":"', vm.toString(bidId), '"}')
        );
        vm.prank(who, who);
        (ok,) = address(market).call(data);
    }

    function testFuzz_BidConservation(uint128 price, uint256 amt) public {
        price = uint128(bound(price, 1, 10 ether));
        amt = bound(amt, 1, type(uint128).max);
        uint256 fee = uint256(price) * 500 / 10000;
        uint256 escrow = uint256(price) + fee;
        vm.deal(buyer, escrow);
        vm.prank(buyer);
        uint256 id = market.placeBid{value: escrow}("robin", uint128(amt), price);

        assertTrue(_accept(seller, id));
        uint256 sellerBefore = seller.balance;
        vm.prank(operator);
        market.settleBid(id, seller);
        // escrow == sellerProceeds + platformFees, nothing stuck
        assertEq(seller.balance - sellerBefore + market.accruedFees(), escrow, "bid escrow fully conserved");
        assertEq(address(market).balance, market.accruedFees());
    }

    // ---- fuzz ----

    function testFuzz_ArbitraryCalldataSafe(bytes calldata data) public {
        vm.prank(seller);
        (bool ok,) = address(market).call(data);
        ok;
        // Arbitrary calldata either reverts (nextId unchanged) or is a valid list
        // inscription (nextId advances by exactly 1, creating one well-formed,
        // seller-owned Pending listing). It can never corrupt state some other way.
        uint256 next = market.nextId();
        assertTrue(next == 1 || next == 2, "at most one listing created");
        if (next == 2) {
            (address s,,,, InscriptionMarket.Status st) = market.listings(1);
            assertEq(s, seller, "listing owned by caller");
            assertEq(uint8(st), uint8(InscriptionMarket.Status.Pending), "new listing is Pending");
        }
    }
}
