// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626, ERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title sUSDr — yield-bearing vault over USDr (ERC-4626)
/// @notice Share-price appreciation model: sUSDr never rebases; instead
///         each sUSDr redeems for more USDr as real yield is reported.
///
///         Real-world flow: capital is deployed OFF-chain into RWA /
///         lending / liquidity / treasury strategies. Authorized reporters
///         (ORACLE_ROLE — expected to be a multisig or the YieldManager)
///         periodically `reportYield`, transferring harvested USDr in.
///         `totalAssets()` = USDr actually held + assets recorded as
///         deployed off-chain (deployedAssets), so the exchange rate
///         reflects both idle and working capital.
///
///         Protocol fee is charged ON YIELD ONLY (never on principal),
///         capped at 20%, and settled by minting shares to the treasury —
///         dilution, not asset removal — mirroring the Cardano
///         implementation exactly so both chains produce identical
///         exchange-rate curves for identical event sequences.
contract sUSDr is ERC4626, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");

    uint256 public constant MAX_YIELD_FEE_BPS = 2_000; // 20%
    uint256 public constant MIN_INITIAL_DEPOSIT = 10e6; // 10 USDr
    uint256 public constant MIN_REPORT_INTERVAL = 1 hours; // manipulation damper

    uint16 public yieldFeeBps;
    address public treasury;

    /// @notice USDr recorded as deployed to off-chain strategies.
    uint256 public deployedAssets;

    uint64 public lastReportAt;
    /// @dev ring buffer of recent reports for the APY estimate view
    struct Report { uint128 grossYield; uint64 at; }
    Report[] public reports;

    event YieldReported(uint256 grossYield, uint256 fee, uint256 feeShares, uint256 newRate);
    event CapitalDeployed(uint256 amount, address indexed to);
    event CapitalReturned(uint256 amount);
    event FeeUpdated(uint16 bps);
    event TreasuryUpdated(address treasury);

    error FeeAboveCap();
    error BelowMinimumInitialDeposit();
    error ReportTooSoon();
    error ZeroYield();

    constructor(IERC20 usdr, address admin, address treasury_, uint16 feeBps)
        ERC4626(usdr)
        ERC20("Staked USDr", "sUSDr")
    {
        if (feeBps > MAX_YIELD_FEE_BPS) revert FeeAboveCap();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        treasury = treasury_;
        yieldFeeBps = feeBps;
    }

    // ----------------------------------------------------------- accounting

    /// @dev idle USDr in the vault + USDr working off-chain
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) + deployedAssets;
    }

    /// @notice USDr per 1e6 sUSDr (starts at 1_000_000 and rises)
    function exchangeRateE6() external view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return 1e6;
        return (totalAssets() * 1e6) / supply;
    }

    /// @notice naive annualized estimate from reports in the last 30 days;
    ///         indicative only, never a promise
    function estimatedApyBps() external view returns (uint256) {
        uint256 window = 30 days;
        uint256 cutoff = block.timestamp > window ? block.timestamp - window : 0;
        uint256 recent;
        for (uint256 i = reports.length; i > 0; i--) {
            Report storage r = reports[i - 1];
            if (r.at < cutoff) break;
            recent += r.grossYield;
        }
        uint256 assets_ = totalAssets();
        if (assets_ == 0 || recent == 0) return 0;
        return (recent * 10_000 * 365 days) / (assets_ * window);
    }

    // ----------------------------------------------------------- user flows

    /// @dev enforce the first-depositor floor (inflation-attack damper on
    ///      top of OZ v5's virtual-shares defense) and pausing
    function _deposit(address caller, address receiver, uint256 assets_, uint256 shares)
        internal
        override
        whenNotPaused
        nonReentrant
    {
        if (totalSupply() == 0 && assets_ < MIN_INITIAL_DEPOSIT) {
            revert BelowMinimumInitialDeposit();
        }
        super._deposit(caller, receiver, assets_, shares);
    }

    /// @dev withdrawals stay open while paused (mirror of the Cardano rule:
    ///      pause blocks new exposure, never exit) — hence no whenNotPaused
    function _withdraw(address caller, address receiver, address owner, uint256 assets_, uint256 shares)
        internal
        override
        nonReentrant
    {
        super._withdraw(caller, receiver, owner, assets_, shares);
    }

    // ----------------------------------------------------------- yield flow

    /// @notice Report harvested real yield. Caller must have transferred /
    ///         must hold and approve `grossYield` USDr; it is pulled in here.
    ///         Fee is minted to the treasury as shares.
    function reportYield(uint256 grossYield) external onlyRole(ORACLE_ROLE) nonReentrant {
        if (grossYield == 0) revert ZeroYield();
        if (block.timestamp < lastReportAt + MIN_REPORT_INTERVAL) revert ReportTooSoon();

        IERC20(asset()).safeTransferFrom(msg.sender, address(this), grossYield);

        uint256 fee = (grossYield * yieldFeeBps) / 10_000;
        uint256 feeShares = 0;
        if (fee > 0 && totalSupply() > 0) {
            // solve fee = feeShares * totalAssets / (supply + feeShares)
            feeShares = (fee * totalSupply()) / (totalAssets() - fee);
            _mint(treasury, feeShares);
        }
        lastReportAt = uint64(block.timestamp);
        reports.push(Report(uint128(grossYield), uint64(block.timestamp)));

        uint256 supply = totalSupply();
        emit YieldReported(grossYield, fee, feeShares, supply == 0 ? 1e6 : (totalAssets() * 1e6) / supply);
    }

    // ------------------------------------------------------ capital routing

    /// @notice Move idle USDr out to an off-chain strategy custodian.
    ///         Book-keeps it as still-owned so the rate doesn't dip.
    function deployCapital(uint256 amount, address to) external onlyRole(MANAGER_ROLE) nonReentrant {
        deployedAssets += amount;
        IERC20(asset()).safeTransfer(to, amount);
        emit CapitalDeployed(amount, to);
    }

    /// @notice Return principal from a strategy (yield returns via reportYield).
    function returnCapital(uint256 amount) external onlyRole(MANAGER_ROLE) nonReentrant {
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
        deployedAssets = deployedAssets >= amount ? deployedAssets - amount : 0;
        emit CapitalReturned(amount);
    }

    // ------------------------------------------------------------- admin

    function setFee(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_YIELD_FEE_BPS) revert FeeAboveCap();
        yieldFeeBps = bps;
        emit FeeUpdated(bps);
    }

    function setTreasury(address t) external onlyRole(DEFAULT_ADMIN_ROLE) {
        treasury = t;
        emit TreasuryUpdated(t);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    /// @dev protocol-favoring rounding is inherited from OZ ERC4626
    ///      (deposit/mint round down for the user, withdraw rounds up the
    ///      shares burned)
}
