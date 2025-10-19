pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract CharacterStakingFiFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error InvalidBatchState();
    error ReplayDetected();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();
    error InvalidArgument();

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    bool public batchOpen;
    mapping(uint256 => uint256) public stakesInBatch;
    mapping(uint256 => mapping(address => uint256)) public userStakesInBatch;
    mapping(uint256 => mapping(address => euint32)) public encryptedLevelForStake;
    mapping(uint256 => mapping(address => euint32)) public encryptedRarityForStake;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event ContractPaused(address indexed account);
    event ContractUnpaused(address indexed account);
    event CooldownSecondsChanged(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event StakeSubmitted(address indexed staker, uint256 indexed batchId, uint256 stakeId, bytes32 encryptedLevel, bytes32 encryptedRarity);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalYield);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkCooldown(address user) {
        if (block.timestamp < lastSubmissionTime[user] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        emit ProviderAdded(owner);
        cooldownSeconds = 60; // Default 1 minute cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidArgument();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        if (provider == address(0)) revert InvalidArgument();
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            delete isProvider[provider];
            emit ProviderRemoved(provider);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        if (_paused != paused) {
            paused = _paused;
            if (_paused) {
                emit ContractPaused(msg.sender);
            } else {
                emit ContractUnpaused(msg.sender);
            }
        }
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        emit CooldownSecondsChanged(cooldownSeconds, newCooldownSeconds);
        cooldownSeconds = newCooldownSeconds;
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batchOpen) revert InvalidBatchState();
        currentBatchId++;
        batchOpen = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batchOpen) revert InvalidBatchState();
        batchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitStake(
        address staker,
        euint32 encryptedLevel,
        euint32 encryptedRarity
    ) external onlyProvider whenNotPaused checkCooldown(staker) {
        if (!batchOpen) revert InvalidBatchState();
        _initIfNeeded(encryptedLevel);
        _initIfNeeded(encryptedRarity);

        stakesInBatch[currentBatchId]++;
        uint256 stakeId = stakesInBatch[currentBatchId];
        userStakesInBatch[currentBatchId][staker] = stakeId;
        encryptedLevelForStake[currentBatchId][staker] = encryptedLevel;
        encryptedRarityForStake[currentBatchId][staker] = encryptedRarity;

        lastSubmissionTime[staker] = block.timestamp;

        emit StakeSubmitted(
            staker,
            currentBatchId,
            stakeId,
            FHE.toBytes32(encryptedLevel),
            FHE.toBytes32(encryptedRarity)
        );
    }

    function requestBatchYieldCalculation(uint256 batchId) external onlyOwner whenNotPaused checkCooldown(msg.sender) {
        if (stakesInBatch[batchId] == 0) revert InvalidArgument(); // Batch must have stakes

        euint32 encryptedTotalYield = FHE.asEuint32(0);
        uint256 numStakes = stakesInBatch[batchId];

        for (uint256 i = 0; i < numStakes; ) {
            address staker = address(uint160(i + 1)); // Placeholder: In a real scenario, iterate actual stakers
            euint32 level = encryptedLevelForStake[batchId][staker];
            euint32 rarity = encryptedRarityForStake[batchId][staker];

            _initIfNeeded(level);
            _initIfNeeded(rarity);

            // Yield = Level * Rarity
            euint32 stakeYield = level.fheMul(rarity);
            encryptedTotalYield = encryptedTotalYield.fheAdd(stakeYield);

            unchecked {
                i++;
            }
        }

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(encryptedTotalYield);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();
        if (cleartexts.length != 32) revert InvalidArgument(); // Expecting one uint256

        // 1. State Verification
        // Rebuild cts array in the exact same order as in requestBatchYieldCalculation
        // This ensures the contract state relevant to the decryption hasn't changed.
        bytes32[] memory cts = new bytes32[](1);
        euint32 currentEncryptedTotalYield = FHE.asEuint32(0);
        uint256 numStakes = stakesInBatch[decryptionContexts[requestId].batchId];

        for (uint256 i = 0; i < numStakes; ) {
            address staker = address(uint160(i + 1)); // Placeholder: In a real scenario, iterate actual stakers
            euint32 level = encryptedLevelForStake[decryptionContexts[requestId].batchId][staker];
            euint32 rarity = encryptedRarityForStake[decryptionContexts[requestId].batchId][staker];

            _initIfNeeded(level);
            _initIfNeeded(rarity);

            euint32 stakeYield = level.fheMul(rarity);
            currentEncryptedTotalYield = currentEncryptedTotalYield.fheAdd(stakeYield);
            unchecked { i++; }
        }
        cts[0] = FHE.toBytes32(currentEncryptedTotalYield);

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        // 2. Proof Verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        // 3. Decode & Finalize
        uint256 totalYield = abi.decode(cleartexts, (uint256));
        decryptionContexts[requestId].processed = true;

        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, totalYield);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 val) internal pure {
        if (!FHE.isInitialized(val)) revert NotInitialized();
    }

    function _requireInitialized(euint32 val) internal pure {
        _initIfNeeded(val);
    }
}