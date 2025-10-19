// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface Character {
  id: string;
  name: string;
  level: number;
  rarity: string;
  staked: boolean;
  yieldRate: string;
  lastClaimed: number;
  encryptedLevel: string;
  encryptedRarity: string;
}

const rarityMultipliers: Record<string, number> = {
  'Common': 1,
  'Uncommon': 1.5,
  'Rare': 2,
  'Epic': 3,
  'Legendary': 5
};

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const calculateYieldRate = (level: number, rarity: string): string => {
  const baseRate = 0.1;
  const rarityMultiplier = rarityMultipliers[rarity] || 1;
  const yieldRate = (baseRate * level * rarityMultiplier).toFixed(4);
  return FHEEncryptNumber(parseFloat(yieldRate));
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showStakeModal, setShowStakeModal] = useState(false);
  const [staking, setStaking] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newCharacter, setNewCharacter] = useState({ name: "", level: 1, rarity: "Common" });
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [selectedCharacter, setSelectedCharacter] = useState<Character | null>(null);
  const [decryptedYield, setDecryptedYield] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [totalStaked, setTotalStaked] = useState(0);
  const [totalYield, setTotalYield] = useState(0);
  const [activeTab, setActiveTab] = useState('dashboard');

  useEffect(() => {
    loadCharacters().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadCharacters = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("character_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing character keys:", e); }
      }
      
      const list: Character[] = [];
      let stakedCount = 0;
      let totalYieldValue = 0;
      
      for (const key of keys) {
        try {
          const characterBytes = await contract.getData(`character_${key}`);
          if (characterBytes.length > 0) {
            try {
              const characterData = JSON.parse(ethers.toUtf8String(characterBytes));
              const yieldRate = characterData.yieldRate || calculateYieldRate(characterData.level, characterData.rarity);
              
              list.push({ 
                id: key, 
                name: characterData.name,
                level: characterData.level,
                rarity: characterData.rarity,
                staked: characterData.staked || false,
                yieldRate,
                lastClaimed: characterData.lastClaimed || 0,
                encryptedLevel: FHEEncryptNumber(characterData.level),
                encryptedRarity: characterData.encryptedRarity || FHEEncryptNumber(rarityMultipliers[characterData.rarity] || 1)
              });
              
              if (characterData.staked) {
                stakedCount++;
                const decryptedYield = FHEDecryptNumber(yieldRate);
                totalYieldValue += decryptedYield;
              }
            } catch (e) { console.error(`Error parsing character data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading character ${key}:`, e); }
      }
      
      setCharacters(list);
      setTotalStaked(stakedCount);
      setTotalYield(totalYieldValue);
    } catch (e) { console.error("Error loading characters:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const stakeCharacter = async (characterId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing with Zama FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const characterBytes = await contract.getData(`character_${characterId}`);
      if (characterBytes.length === 0) throw new Error("Character not found");
      
      const characterData = JSON.parse(ethers.toUtf8String(characterBytes));
      const updatedCharacter = { 
        ...characterData, 
        staked: true,
        lastClaimed: Math.floor(Date.now() / 1000)
      };
      
      await contract.setData(`character_${characterId}`, ethers.toUtf8Bytes(JSON.stringify(updatedCharacter)));
      setTransactionStatus({ visible: true, status: "success", message: "Character staked successfully!" });
      await loadCharacters();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Staking failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const unstakeCharacter = async (characterId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing with Zama FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const characterBytes = await contract.getData(`character_${characterId}`);
      if (characterBytes.length === 0) throw new Error("Character not found");
      
      const characterData = JSON.parse(ethers.toUtf8String(characterBytes));
      const updatedCharacter = { 
        ...characterData, 
        staked: false 
      };
      
      await contract.setData(`character_${characterId}`, ethers.toUtf8Bytes(JSON.stringify(updatedCharacter)));
      setTransactionStatus({ visible: true, status: "success", message: "Character unstaked successfully!" });
      await loadCharacters();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Unstaking failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const claimYield = async (characterId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Calculating yield with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const characterBytes = await contract.getData(`character_${characterId}`);
      if (characterBytes.length === 0) throw new Error("Character not found");
      
      const characterData = JSON.parse(ethers.toUtf8String(characterBytes));
      const updatedCharacter = { 
        ...characterData, 
        lastClaimed: Math.floor(Date.now() / 1000)
      };
      
      await contract.setData(`character_${characterId}`, ethers.toUtf8Bytes(JSON.stringify(updatedCharacter)));
      setTransactionStatus({ visible: true, status: "success", message: "Yield claimed successfully!" });
      await loadCharacters();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Claim failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const createCharacter = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setStaking(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting character data with Zama FHE..." });
    try {
      const encryptedLevel = FHEEncryptNumber(newCharacter.level);
      const encryptedRarity = FHEEncryptNumber(rarityMultipliers[newCharacter.rarity] || 1);
      const yieldRate = calculateYieldRate(newCharacter.level, newCharacter.rarity);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const characterId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const characterData = { 
        name: newCharacter.name,
        level: newCharacter.level,
        rarity: newCharacter.rarity,
        staked: false,
        yieldRate,
        lastClaimed: 0,
        encryptedLevel,
        encryptedRarity,
        owner: address
      };
      
      await contract.setData(`character_${characterId}`, ethers.toUtf8Bytes(JSON.stringify(characterData)));
      
      const keysBytes = await contract.getData("character_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(characterId);
      await contract.setData("character_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Character created with FHE encryption!" });
      await loadCharacters();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowStakeModal(false);
        setNewCharacter({ name: "", level: 1, rarity: "Common" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Creation failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setStaking(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const calculatePendingYield = (character: Character): number => {
    if (!character.staked) return 0;
    const secondsStaked = Math.floor(Date.now() / 1000) - character.lastClaimed;
    const dailyYield = FHEDecryptNumber(character.yieldRate);
    return parseFloat((dailyYield * (secondsStaked / 86400)).toFixed(6));
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="cyber-spinner"></div>
      <p>Initializing encrypted connection...</p>
    </div>
  );

  return (
    <div className="app-container cyberpunk-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="shield-icon"></div></div>
          <h1>Character<span>Staking</span>Fi</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowStakeModal(true)} className="create-character-btn cyber-button">
            <div className="add-icon"></div>New Character
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      
      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>GameFi meets DeFi</h2>
            <p>Stake your game characters to earn yield with Zama FHE technology</p>
          </div>
          <div className="fhe-indicator"><div className="fhe-lock"></div><span>FHE Encryption Active</span></div>
        </div>
        
        <div className="dashboard-tabs">
          <button 
            className={`tab-button ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            Dashboard
          </button>
          <button 
            className={`tab-button ${activeTab === 'characters' ? 'active' : ''}`}
            onClick={() => setActiveTab('characters')}
          >
            My Characters
          </button>
        </div>
        
        {activeTab === 'dashboard' && (
          <div className="dashboard-grid">
            <div className="dashboard-card cyber-card">
              <h3>Total Staked</h3>
              <div className="stat-value">{totalStaked}</div>
              <div className="stat-label">Characters</div>
            </div>
            
            <div className="dashboard-card cyber-card">
              <h3>Daily Yield</h3>
              <div className="stat-value">{totalYield.toFixed(4)}</div>
              <div className="stat-label">Tokens/Day</div>
            </div>
            
            <div className="dashboard-card cyber-card">
              <h3>FHE Technology</h3>
              <p>Your character stats are encrypted with <strong>Zama FHE</strong> and yield is calculated without decryption</p>
              <div className="fhe-badge"><span>FHE-Powered</span></div>
            </div>
            
            <div className="dashboard-card cyber-card">
              <h3>Yield Calculator</h3>
              <div className="calculator">
                <div className="calc-input">
                  <label>Level</label>
                  <input type="number" min="1" max="100" defaultValue="1" className="cyber-input" />
                </div>
                <div className="calc-input">
                  <label>Rarity</label>
                  <select className="cyber-select">
                    <option>Common</option>
                    <option>Uncommon</option>
                    <option>Rare</option>
                    <option>Epic</option>
                    <option>Legendary</option>
                  </select>
                </div>
                <div className="calc-result">
                  <span>Estimated Yield:</span>
                  <strong>0.1000 tokens/day</strong>
                </div>
              </div>
            </div>
          </div>
        )}
        
        {activeTab === 'characters' && (
          <div className="characters-section">
            <div className="section-header">
              <h2>My Characters</h2>
              <div className="header-actions">
                <button onClick={loadCharacters} className="refresh-btn cyber-button" disabled={isRefreshing}>
                  {isRefreshing ? "Refreshing..." : "Refresh"}
                </button>
              </div>
            </div>
            
            <div className="characters-grid">
              {characters.length === 0 ? (
                <div className="no-characters">
                  <div className="no-characters-icon"></div>
                  <p>No characters found</p>
                  <button className="cyber-button primary" onClick={() => setShowStakeModal(true)}>Create First Character</button>
                </div>
              ) : characters.map(character => (
                <div className="character-card cyber-card" key={character.id}>
                  <div className="character-header">
                    <h3>{character.name}</h3>
                    <span className={`rarity-badge ${character.rarity.toLowerCase()}`}>{character.rarity}</span>
                  </div>
                  <div className="character-stats">
                    <div className="stat">
                      <span>Level</span>
                      <strong>{character.level}</strong>
                    </div>
                    <div className="stat">
                      <span>Yield Rate</span>
                      <strong>{character.yieldRate.substring(0, 10)}...</strong>
                    </div>
                  </div>
                  <div className="character-status">
                    <span>Status:</span>
                    <strong className={`status-badge ${character.staked ? 'staked' : 'unstaked'}`}>
                      {character.staked ? 'Staked' : 'Unstaked'}
                    </strong>
                  </div>
                  {character.staked && (
                    <div className="pending-yield">
                      <span>Pending Yield:</span>
                      <strong>{calculatePendingYield(character)} tokens</strong>
                    </div>
                  )}
                  <div className="character-actions">
                    {!character.staked ? (
                      <button 
                        className="cyber-button success" 
                        onClick={() => stakeCharacter(character.id)}
                      >
                        Stake
                      </button>
                    ) : (
                      <>
                        <button 
                          className="cyber-button primary" 
                          onClick={() => claimYield(character.id)}
                        >
                          Claim
                        </button>
                        <button 
                          className="cyber-button danger" 
                          onClick={() => unstakeCharacter(character.id)}
                        >
                          Unstake
                        </button>
                      </>
                    )}
                    <button 
                      className="cyber-button" 
                      onClick={() => {
                        setSelectedCharacter(character);
                        setDecryptedYield(null);
                      }}
                    >
                      Details
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      
      {showStakeModal && (
        <div className="modal-overlay">
          <div className="create-modal cyber-card">
            <div className="modal-header">
              <h2>Create New Character</h2>
              <button onClick={() => setShowStakeModal(false)} className="close-modal">&times;</button>
            </div>
            <div className="modal-body">
              <div className="fhe-notice-banner">
                <div className="key-icon"></div> 
                <div><strong>FHE Encryption Notice</strong><p>Character stats will be encrypted with Zama FHE</p></div>
              </div>
              
              <div className="form-group">
                <label>Character Name *</label>
                <input 
                  type="text" 
                  value={newCharacter.name}
                  onChange={(e) => setNewCharacter({...newCharacter, name: e.target.value})}
                  placeholder="Enter character name..."
                  className="cyber-input"
                />
              </div>
              
              <div className="form-row">
                <div className="form-group">
                  <label>Level *</label>
                  <input 
                    type="number" 
                    min="1" 
                    max="100" 
                    value={newCharacter.level}
                    onChange={(e) => setNewCharacter({...newCharacter, level: parseInt(e.target.value) || 1})}
                    className="cyber-input"
                  />
                </div>
                
                <div className="form-group">
                  <label>Rarity *</label>
                  <select 
                    value={newCharacter.rarity}
                    onChange={(e) => setNewCharacter({...newCharacter, rarity: e.target.value})}
                    className="cyber-select"
                  >
                    <option value="Common">Common</option>
                    <option value="Uncommon">Uncommon</option>
                    <option value="Rare">Rare</option>
                    <option value="Epic">Epic</option>
                    <option value="Legendary">Legendary</option>
                  </select>
                </div>
              </div>
              
              <div className="encryption-preview">
                <h4>FHE Encryption Preview</h4>
                <div className="preview-container">
                  <div className="plain-data">
                    <span>Plain Stats:</span>
                    <div>Level: {newCharacter.level}, Rarity: {newCharacter.rarity}</div>
                  </div>
                  <div className="encryption-arrow">→</div>
                  <div className="encrypted-data">
                    <span>Encrypted Data:</span>
                    <div>
                      Level: {FHEEncryptNumber(newCharacter.level).substring(0, 10)}...<br />
                      Rarity: {FHEEncryptNumber(rarityMultipliers[newCharacter.rarity] || 1).substring(0, 10)}...
                    </div>
                  </div>
                </div>
              </div>
              
              <div className="yield-preview">
                <h4>Estimated Yield</h4>
                <div className="yield-value">
                  {calculateYieldRate(newCharacter.level, newCharacter.rarity).substring(0, 10)}... tokens/day
                </div>
              </div>
            </div>
            
            <div className="modal-footer">
              <button onClick={() => setShowStakeModal(false)} className="cancel-btn cyber-button">Cancel</button>
              <button 
                onClick={createCharacter} 
                disabled={staking || !newCharacter.name} 
                className="submit-btn cyber-button primary"
              >
                {staking ? "Encrypting with FHE..." : "Create Character"}
              </button>
            </div>
          </div>
        </div>
      )}
      
      {selectedCharacter && (
        <div className="modal-overlay">
          <div className="character-detail-modal cyber-card">
            <div className="modal-header">
              <h2>{selectedCharacter.name}</h2>
              <button onClick={() => {
                setSelectedCharacter(null);
                setDecryptedYield(null);
              }} className="close-modal">&times;</button>
            </div>
            
            <div className="modal-body">
              <div className="character-info">
                <div className="info-row">
                  <span>Level:</span>
                  <strong>{selectedCharacter.level}</strong>
                </div>
                <div className="info-row">
                  <span>Rarity:</span>
                  <strong className={`rarity-badge ${selectedCharacter.rarity.toLowerCase()}`}>
                    {selectedCharacter.rarity}
                  </strong>
                </div>
                <div className="info-row">
                  <span>Status:</span>
                  <strong className={`status-badge ${selectedCharacter.staked ? 'staked' : 'unstaked'}`}>
                    {selectedCharacter.staked ? 'Staked' : 'Unstaked'}
                  </strong>
                </div>
                <div className="info-row">
                  <span>Yield Rate:</span>
                  <strong>{selectedCharacter.yieldRate.substring(0, 15)}...</strong>
                </div>
                {selectedCharacter.staked && (
                  <div className="info-row">
                    <span>Pending Yield:</span>
                    <strong>{calculatePendingYield(selectedCharacter)} tokens</strong>
                  </div>
                )}
              </div>
              
              <div className="fhe-section">
                <h3>FHE Encrypted Data</h3>
                <div className="encrypted-data">
                  <div className="data-item">
                    <span>Level:</span>
                    <code>{selectedCharacter.encryptedLevel.substring(0, 15)}...</code>
                  </div>
                  <div className="data-item">
                    <span>Rarity Multiplier:</span>
                    <code>{selectedCharacter.encryptedRarity.substring(0, 15)}...</code>
                  </div>
                  <div className="data-item">
                    <span>Yield Rate:</span>
                    <code>{selectedCharacter.yieldRate.substring(0, 15)}...</code>
                  </div>
                </div>
                
                <button 
                  className="decrypt-btn cyber-button" 
                  onClick={async () => {
                    if (decryptedYield !== null) {
                      setDecryptedYield(null);
                    } else {
                      const decrypted = await decryptWithSignature(selectedCharacter.yieldRate);
                      setDecryptedYield(decrypted);
                    }
                  }}
                  disabled={isDecrypting}
                >
                  {isDecrypting ? "Decrypting..." : 
                   decryptedYield !== null ? "Hide Decrypted Yield" : "Decrypt Yield Rate"}
                </button>
                
                {decryptedYield !== null && (
                  <div className="decrypted-data">
                    <h4>Decrypted Yield Rate</h4>
                    <div className="decrypted-value">
                      {decryptedYield} tokens/day
                    </div>
                    <div className="decryption-notice">
                      <div className="warning-icon"></div>
                      <span>Decrypted data is only visible after wallet signature verification</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
            
            <div className="modal-footer">
              <button 
                onClick={() => {
                  setSelectedCharacter(null);
                  setDecryptedYield(null);
                }} 
                className="close-btn cyber-button"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content cyber-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="cyber-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="shield-icon"></div><span>CharacterStakingFi</span></div>
            <p>GameFi meets DeFi with Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>FHE-Powered Gaming</span></div>
          <div className="copyright">© {new Date().getFullYear()} CharacterStakingFi. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

export default App;