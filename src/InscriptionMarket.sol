// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

/// @title InscriptionMarket — escrow marketplace for arc-20 inscriptions
/// @notice Sellers list by sending the raw `op:"list"` inscription calldata to
///         this contract (the indexer escrows their balance per PROTOCOL.md).
///         The platform operator confirms listings whose escrow the indexer
///         validated; buyers can only buy confirmed (Active) listings. A 5%
///         platform fee is charged to EACH side (buyer pays price + 5%, seller
///         receives price - 5%). Fee rate is a constant and cannot be changed.
///         `sweep` buys several listings in one tx, skipping any that were
///         taken/cancelled meanwhile and refunding the unspent remainder.
contract InscriptionMarket is Ownable, ReentrancyGuard {
    uint256 public constant FEE_BPS = 500; // 5% per side, immutable by construction
    uint256 public constant MAX_SWEEP = 50; // bound sweep gas

    bytes internal constant PREFIX = 'data:,{"p":"arc-20","op":"list","tick":"';
    bytes internal constant AMT_MARKER = '","amt":"';
    bytes internal constant PRICE_MARKER = '","price":"';
    bytes internal constant TAIL = '"}';

    // accept inscriptions hit the same fallback as lists and bind the fill:
    // PREFIX_ACCEPT <tick> BID_MARKER <bid> TAIL
    bytes internal constant PREFIX_ACCEPT = 'data:,{"p":"arc-20","op":"accept","tick":"';
    bytes internal constant BID_MARKER = '","bid":"';

    enum Status {
        None,
        Pending, // listed on-chain, escrow not yet validated by the indexer/oracle
        Active, // escrow confirmed — buyable
        Sold,
        Cancelled
    }

    struct Listing {
        address seller;
        bytes32 tickHash;
        uint128 amt;
        uint128 price; // wei, whole-listing price
        Status status;
    }

    // A bid is a buy order: the bidder escrows ETH (price + buyer fee) on-chain.
    // A seller binds the fill ON-CHAIN by sending an `op:"accept"` inscription to
    // this contract (first-come-first-served; see _parseAccept): the binding is
    // the delivery proof, and settleBid can only pay the bound pendingSeller —
    // the operator key can delay but never redirect bid escrow. The indexer
    // independently validates the seller's balance on the BidAccepted event and
    // moves the escrowed inscription to the bidder on BidFilled.
    enum BidStatus {
        None,
        Open,
        Filled,
        Cancelled
    }

    struct Bid {
        address bidder;
        bytes32 tickHash;
        uint128 amt;
        uint128 price; // wei, whole-bid price (excl. fee)
        address pendingSeller; // seller bound by the accept inscription (0 = unbound)
        BidStatus status;
    }

    address public operator; // oracle key run by the platform indexer
    uint256 public nextId = 1;
    uint256 public nextBidId = 1;
    uint256 public accruedFees;
    mapping(uint256 id => Listing) public listings;
    mapping(uint256 id => Bid) public bids;
    mapping(address seller => uint256) public pendingProceeds; // credited if direct payout fails

    event Listed(
        uint256 indexed id, address indexed seller, bytes32 indexed tickHash, string tick, uint256 amt, uint256 price
    );
    event ListingConfirmed(uint256 indexed id);
    event Bought(uint256 indexed id, address indexed buyer);
    event Cancelled(uint256 indexed id);
    event BidPlaced(
        uint256 indexed id, address indexed bidder, bytes32 indexed tickHash, string tick, uint256 amt, uint256 price
    );
    event BidAccepted(uint256 indexed id, address indexed seller, bytes32 indexed tickHash);
    event BidFilled(uint256 indexed id, address indexed seller);
    event BidCancelled(uint256 indexed id);

    error BadInscription();
    error WrongPayment();
    error NotOperator();
    error NotSeller();
    error NotBidder();
    error NotPendingSeller();
    error BidTaken();
    error BadState();
    error NothingToClaim();
    error ZeroAddress();
    error BadSweepLength();
    error NothingBought();
    error BadTick();
    error BadAmount();

    constructor(address owner_, address operator_) Ownable(owner_) {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
    }

    // ---- list & accept (raw inscription calldata hits the fallback) ----

    fallback() external payable {
        if (msg.value != 0) revert WrongPayment(); // inscriptions carry no ETH

        // dispatch on the op prefix: `list` creates a listing, `accept` binds a
        // bid fill; anything else reverts in the respective parser
        if (
            msg.data.length >= PREFIX.length && _matchesConst(msg.data, 0, PREFIX)
        ) {
            (bytes32 th, bytes calldata tick, uint256 amt, uint256 price) = _parseList(msg.data);

            uint256 id = nextId++;
            listings[id] = Listing({
                seller: msg.sender, tickHash: th, amt: uint128(amt), price: uint128(price), status: Status.Pending
            });
            emit Listed(id, msg.sender, th, string(tick), amt, price);
        } else {
            (uint256 bidId, bytes32 th) = _parseAccept(msg.data);
            Bid storage b = bids[bidId];
            if (b.status != BidStatus.Open) revert BadState();
            if (th != b.tickHash) revert BadInscription(); // accepting the wrong tick
            if (b.pendingSeller != address(0)) revert BidTaken(); // first come, first served
            b.pendingSeller = msg.sender;
            emit BidAccepted(bidId, msg.sender, th);
        }
    }

    receive() external payable {
        revert BadInscription();
    }

    // ---- lifecycle ----

    function confirm(uint256 id) external {
        if (msg.sender != operator) revert NotOperator();
        Listing storage l = listings[id];
        if (l.status != Status.Pending) revert BadState();
        l.status = Status.Active;
        emit ListingConfirmed(id);
    }

    function cancel(uint256 id) external {
        Listing storage l = listings[id];
        if (msg.sender != l.seller) revert NotSeller();
        if (l.status != Status.Pending && l.status != Status.Active) revert BadState();
        l.status = Status.Cancelled;
        emit Cancelled(id);
    }

    /// @notice Cancel several of your own listings in one transaction.
    ///         DECIDED SEMANTICS — skip-any (never reverts on per-item
    ///         business state): an item that is not the caller's listing, or
    ///         that is no longer Pending/Active (bought/cancelled meanwhile),
    ///         is skipped so market making never bricks on one raced order.
    ///         Returns the number of listings actually cancelled.
    function cancelMany(uint256[] calldata ids) external nonReentrant returns (uint256 cancelled) {
        for (uint256 k = 0; k < ids.length; k++) {
            Listing storage l = listings[ids[k]];
            if (l.seller != msg.sender) continue; // someone else's order
            if (l.status != Status.Pending && l.status != Status.Active) continue;
            l.status = Status.Cancelled;
            cancelled++;
            emit Cancelled(ids[k]);
        }
    }

    function buy(uint256 id) external payable nonReentrant {
        Listing storage l = listings[id];
        if (l.status != Status.Active) revert BadState();

        uint256 price = l.price;
        uint256 fee = (price * FEE_BPS) / 10000; // 5% of price, floored
        if (msg.value != price + fee) revert WrongPayment(); // buyer side

        l.status = Status.Sold; // effects before interactions
        accruedFees += 2 * fee; // buyer fee + seller fee
        uint256 sellerProceeds = price - fee; // seller side

        (bool ok,) = l.seller.call{value: sellerProceeds}("");
        if (!ok) pendingProceeds[l.seller] += sellerProceeds;

        emit Bought(id, msg.sender);
    }

    /// @notice Buy several listings in one tx. Listings that are no longer
    ///         Active (taken/cancelled since the caller built the list) are
    ///         skipped, as is any lot the remaining budget can't cover; the
    ///         unspent remainder of msg.value is refunded. Reverts only if
    ///         nothing at all could be bought.
    function sweep(uint256[] calldata ids) external payable nonReentrant {
        if (ids.length == 0 || ids.length > MAX_SWEEP) revert BadSweepLength();

        uint256 spent = 0;
        for (uint256 k = 0; k < ids.length; k++) {
            Listing storage l = listings[ids[k]];
            if (l.status != Status.Active) continue; // taken/cancelled meanwhile

            uint256 price = l.price;
            uint256 fee = (price * FEE_BPS) / 10000;
            uint256 cost = price + fee;
            if (spent + cost > msg.value) continue; // over budget — skip this lot

            l.status = Status.Sold; // effects before interactions
            spent += cost;
            accruedFees += 2 * fee;
            uint256 sellerProceeds = price - fee;

            (bool ok,) = l.seller.call{value: sellerProceeds}("");
            if (!ok) pendingProceeds[l.seller] += sellerProceeds;

            emit Bought(ids[k], msg.sender);
        }

        if (spent == 0) revert NothingBought();

        uint256 refund = msg.value - spent;
        if (refund > 0) {
            // graceful: a refusing buyer's overpay is parked as a pending
            // refund instead of reverting the whole sweep (and stranding the
            // just-bought listings' state)
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) pendingProceeds[msg.sender] += refund;
        }
    }

    // ---- bids (buy orders) ----

    /// @notice Place a buy order for `amt` of `tick` at total `price`, escrowing
    ///         `price + 5%` ETH on-chain. A seller binds the fill by sending an
    ///         `accept` inscription to this contract (see PROTOCOL.md); the
    ///         operator then settles to the bound seller only.
    function placeBid(string calldata tick, uint128 amt, uint128 price)
        external
        payable
        nonReentrant
        returns (uint256 id)
    {
        bytes calldata t = bytes(tick);
        if (t.length == 0 || t.length > 8) revert BadTick();
        for (uint256 i = 0; i < t.length; i++) {
            bytes1 c = t[i];
            if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39))) revert BadTick();
        }
        if (amt == 0 || price == 0) revert BadAmount();
        uint256 fee = (uint256(price) * FEE_BPS) / 10000;
        if (msg.value != uint256(price) + fee) revert WrongPayment(); // buyer escrows price + 5%

        id = nextBidId++;
        bytes32 th = keccak256(t);
        bids[id] = Bid({
            bidder: msg.sender,
            tickHash: th,
            amt: amt,
            price: price,
            pendingSeller: address(0),
            status: BidStatus.Open
        });
        emit BidPlaced(id, msg.sender, th, tick, amt, price);
    }

    /// @notice Cancel your Open bid and refund the escrowed ETH. If the bidder
    ///         refuses the payout, the refund is parked in pendingProceeds
    ///         (claimable via claimProceeds) instead of bricking the
    ///         cancellation — symmetric with the seller payout path.
    function cancelBid(uint256 id) external nonReentrant {
        Bid storage b = bids[id];
        if (msg.sender != b.bidder) revert NotBidder();
        if (b.status != BidStatus.Open) revert BadState();
        b.status = BidStatus.Cancelled;
        uint256 refund = uint256(b.price) + (uint256(b.price) * FEE_BPS) / 10000;
        emit BidCancelled(id);
        (bool ok,) = b.bidder.call{value: refund}("");
        if (!ok) pendingProceeds[b.bidder] += refund; // graceful, like the seller side
    }

    /// @notice Operator settles an Open bid to the seller bound by the on-chain
    ///         accept inscription (`b.pendingSeller`): pays the seller price - 5%
    ///         and books both platform fees. The `seller` argument must equal the
    ///         on-chain binding, so the operator key can delay a settlement but
    ///         can never redirect bid escrow to another address. The indexer
    ///         moves the escrowed inscription to the bidder on the BidFilled event.
    function settleBid(uint256 id, address seller) external nonReentrant {
        if (msg.sender != operator) revert NotOperator();
        if (seller == address(0)) revert ZeroAddress();
        Bid storage b = bids[id];
        if (b.status != BidStatus.Open) revert BadState();
        if (seller != b.pendingSeller) revert NotPendingSeller(); // delivery not bound on-chain
        b.status = BidStatus.Filled;

        uint256 price = b.price;
        uint256 fee = (price * FEE_BPS) / 10000;
        accruedFees += 2 * fee; // buyer fee (escrowed) + seller fee
        uint256 sellerProceeds = price - fee;

        emit BidFilled(id, seller);
        (bool ok,) = seller.call{value: sellerProceeds}("");
        if (!ok) pendingProceeds[seller] += sellerProceeds;
    }

    /// @notice Fallback payout path for sellers whose direct payment failed.
    function claimProceeds() external nonReentrant {
        uint256 amount = pendingProceeds[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingProceeds[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "claim failed");
    }

    // ---- platform admin ----

    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
    }

    function withdrawFees(address payable to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = accruedFees;
        accruedFees = 0;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    // ---- parsing ----

    /// @dev Strict byte-exact parse of the canonical list inscription:
    ///      PREFIX <tick> AMT_MARKER <amt> PRICE_MARKER <price> TAIL
    function _parseList(bytes calldata d)
        internal
        pure
        returns (bytes32 th, bytes calldata tick, uint256 amt, uint256 price)
    {
        uint256 pLen = PREFIX.length;
        if (d.length < pLen + 1 + AMT_MARKER.length + 1 + PRICE_MARKER.length + 1 + TAIL.length) {
            revert BadInscription();
        }
        if (!_matchesConst(d, 0, PREFIX)) revert BadInscription();

        // tick: 1-8 chars of [a-z0-9]
        uint256 i = pLen;
        while (i < d.length && i - pLen < 8) {
            bytes1 c = d[i];
            if ((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39)) i++;
            else break;
        }
        if (i == pLen) revert BadInscription();
        tick = d[pLen:i];
        th = keccak256(tick);

        uint256 end;
        (amt, end) = _parseUint(d, i, AMT_MARKER, 30);
        (price, i) = _parseUint(d, end, PRICE_MARKER, 30);

        if (amt == 0 || price == 0) revert BadInscription();
        if (amt > type(uint128).max || price > type(uint128).max) revert BadInscription();
        if (d.length != i + TAIL.length || !_matchesConst(d, i, TAIL)) revert BadInscription();
    }

    /// @dev Strict byte-exact parse of the canonical accept inscription:
    ///      PREFIX_ACCEPT <tick> BID_MARKER <bid> TAIL. Returns (bid id,
    ///      keccak256(tick)) — the caller matches th against the bid's tickHash.
    function _parseAccept(bytes calldata d) internal pure returns (uint256 bidId, bytes32 th) {
        uint256 pLen = PREFIX_ACCEPT.length;
        if (d.length < pLen + 1 + BID_MARKER.length + 1 + TAIL.length) revert BadInscription();
        if (!_matchesConst(d, 0, PREFIX_ACCEPT)) revert BadInscription();

        // tick: 1-8 chars of [a-z0-9]
        uint256 i = pLen;
        while (i < d.length && i - pLen < 8) {
            bytes1 c = d[i];
            if ((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39)) i++;
            else break;
        }
        if (i == pLen) revert BadInscription();
        th = keccak256(d[pLen:i]);

        (bidId, i) = _parseUint(d, i, BID_MARKER, 30);
        if (bidId == 0) revert BadInscription(); // bid ids start at 1
        if (d.length != i + TAIL.length || !_matchesConst(d, i, TAIL)) revert BadInscription();
    }

    /// @dev Expects `marker` at d[at:], then 1..maxDigits decimal digits with no
    ///      leading zero. Returns (value, index after the digits).
    function _parseUint(bytes calldata d, uint256 pos, bytes memory marker, uint256 maxDigits)
        internal
        pure
        returns (uint256 value, uint256 end)
    {
        uint256 mLen = marker.length;
        if (pos + mLen > d.length || !_bytesEq(d, pos, marker)) revert BadInscription();
        uint256 i = pos + mLen;
        uint256 start = i;
        while (i < d.length) {
            bytes1 c = d[i];
            if (c < 0x30 || c > 0x39) break;
            value = value * 10 + (uint8(c) - 48);
            i++;
        }
        uint256 len = i - start;
        if (len == 0 || len > maxDigits || (len > 1 && d[start] == "0")) revert BadInscription();
        end = i;
    }

    /// @dev R17: byte-wise comparison of a calldata window against a short
    ///      constant marker — cheaper than hashing both sides with keccak256
    ///      for 2-12 byte markers. Bounds-checked.
    function _matchesConst(bytes calldata d, uint256 pos, bytes memory marker) internal pure returns (bool) {
        if (pos + marker.length > d.length) return false;
        for (uint256 k = 0; k < marker.length; k++) {
            if (d[pos + k] != marker[k]) return false;
        }
        return true;
    }

    /// @dev Byte-equality for a calldata window vs a memory marker (same idea
    ///      as _matchesConst, used by _parseUint callers).
    function _bytesEq(bytes calldata d, uint256 pos, bytes memory marker) internal pure returns (bool) {
        if (pos + marker.length > d.length) return false;
        for (uint256 k = 0; k < marker.length; k++) {
            if (d[pos + k] != marker[k]) return false;
        }
        return true;
    }
}
