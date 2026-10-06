import React, { useState, useEffect, useRef } from 'react';
import { LogOut, User, Menu, X, ChevronDown, AlertTriangle } from 'lucide-react';
import Login from './components/Login';
import ChatBox from './components/ChatBox';
import { checkSession, logoutUser, getAuthConfig, getSapSessionStatus, getSapSessions, selectSapSession } from './services/api';
import nextItPointLogo from './assets/next_it_point_logo.png';

export default function App() {
  const [user, setUser] = useState(null);
  const [authConfig, setAuthConfig] = useState(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [currentSystem, setCurrentSystem] = useState('DEV'); // 'DEV' | 'QA' | 'PROD'
  const [isSessionDropdownOpen, setIsSessionDropdownOpen] = useState(false);
  const [isSwitchingSession, setIsSwitchingSession] = useState(false);
  const sessionDropdownRef = useRef(null);
  const [sapSession, setSapSession] = useState({
    connected: false,
    status: 'CHECKING',
    message: 'Checking SAP connection...',
    system: '',
    client: '',
    user: '',
    selectedUser: '',
    selectedSessionId: null,
    sessions: []
  });

  // Close session dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (sessionDropdownRef.current && !sessionDropdownRef.current.contains(event.target)) {
        setIsSessionDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Verify active session or gateway auth bypass on initial mount
  useEffect(() => {
    async function verifyAuth() {
      try {
        const config = await getAuthConfig();
        setAuthConfig(config);

        if (config.skipGatewayAuth) {
          setUser({
            username: config.bypassUser || 'LEELAM_EXT',
            sapMode: 'gui-only',
            skipGatewayAuth: true
          });
          setIsCheckingAuth(false);
          return;
        }

        const sessionData = await checkSession();
        if (sessionData.authenticated) {
          setUser({
            username: sessionData.username,
            sapMode: sessionData.sapMode
          });
        }
      } catch {
        setUser(null);
      } finally {
        setIsCheckingAuth(false);
      }
    }

    verifyAuth();
  }, []);

  const handleLoginSuccess = (userData) => {
    setUser(userData);
  };

  const handleLogout = async () => {
    try {
      await logoutUser();
    } catch {
      // Ignore network errors during logout
    } finally {
      setUser(null);
    }
  };

  const handleSelectSession = async (sessionId) => {
    if (!sessionId || isSwitchingSession) return;
    setIsSwitchingSession(true);
    try {
      const res = await selectSapSession(sessionId);
      if (res.success) {
        if (res.health) {
          setSapSession(res.health);
        } else {
          setSapSession((prev) => ({
            ...prev,
            selectedSessionId: res.selectedSessionId,
            selectedUser: res.selectedUser,
            user: res.selectedUser,
            connected: true,
            status: 'CONNECTED',
            code: 'CONNECTED'
          }));
        }
        if (res.selectedUser && user && user.username !== res.selectedUser) {
          setUser((prev) => (prev ? { ...prev, username: res.selectedUser } : prev));
        }
        setIsSessionDropdownOpen(false);
      }
    } catch (err) {
      console.error('Failed to select SAP session:', err);
    } finally {
      setIsSwitchingSession(false);
    }
  };

  // SAP GUI Heartbeat monitoring: Polls /api/sap/session-status every ~5s
  useEffect(() => {
    if (!user) return;

    let isMounted = true;
    let timeoutId = null;
    let isPolling = false;

    const pollStatus = async () => {
      if (isPolling || !isMounted) return;
      isPolling = true;
      try {
        const data = await getSapSessionStatus();
        if (isMounted && data) {
          setSapSession(data);
          const activeUser = data.selectedUser || data.user;
          if (activeUser && user && user.username !== activeUser) {
            setUser((prev) => (prev ? { ...prev, username: activeUser } : prev));
          }
        }
      } catch (err) {
        if (isMounted) {
          setSapSession({
            connected: false,
            status: 'SERVER_UNAVAILABLE',
            message: 'The SAP server is currently unavailable. Please start/reconnect SAP and try again.',
            sessions: []
          });
        }
      } finally {
        isPolling = false;
        if (isMounted) {
          timeoutId = setTimeout(pollStatus, 5000);
        }
      }
    };

    pollStatus();

    return () => {
      isMounted = false;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [user]);

  if (isCheckingAuth) {
    return (
      <div className="sap-login-viewport" style={{ color: '#fff', flexDirection: 'column', gap: 16 }}>
        <span className="sap-spinner" style={{ width: 36, height: 36, borderWidth: 3 }} />
        <p style={{ fontSize: 14, opacity: 0.8 }}>Initializing session...</p>
      </div>
    );
  }

  if (!user) {
    return <Login authConfig={authConfig} onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <div className="sap-app-root">
      {/* SAP Shell Top Header */}
      <header className="sap-shell-header">
        <div className="sap-brand">
          <div className="sap-brand-logo-container" title="Next IT Point">
            <img src={nextItPointLogo} alt="Next IT Point" className="sap-brand-logo-img" />
          </div>
          <span className="sap-brand-divider">|</span>
          <span className="sap-brand-title">SAP AI Operations Assistant</span>
        </div>

        {/* Desktop actions and user badge */}
        <div className="sap-shell-actions">
          {/* SAP System Environment Selector */}
          <div className="sap-system-select-wrapper">
            <span className="sap-system-label">System:</span>
            <select
              value={currentSystem}
              onChange={(e) => setCurrentSystem(e.target.value)}
              className={`sap-system-select ${currentSystem === 'PROD' ? 'prod' : ''}`}
            >
              <option value="DEV">DEV (Sandbox)</option>
              <option value="QA">QA (Quality)</option>
              <option value="PROD">PROD (Production)</option>
            </select>
            {currentSystem === 'PROD' && (
              <span className="sap-badge sap-badge-danger" style={{ fontSize: '10px', padding: '2px 6px' }}>
                PROTECTED
              </span>
            )}
          </div>

          {/* SAP GUI Session Selector */}
          <div className="sap-session-select-wrapper" ref={sessionDropdownRef}>
            <span className="sap-session-label">Session:</span>
            <button
              type="button"
              className={`sap-session-selector-btn ${sapSession.code === 'SELECTED_SESSION_UNAVAILABLE' ? 'error' : ''}`}
              onClick={() => setIsSessionDropdownOpen(!isSessionDropdownOpen)}
              title={sapSession.message || 'Click to select active SAP GUI session'}
            >
              <span className="sap-session-user-text">
                {sapSession.selectedUser || sapSession.user || 'No Session'}
              </span>
              {sapSession.system && sapSession.client && (
                <span className="sap-session-env-sub">
                  ({sapSession.system}/{sapSession.client})
                </span>
              )}
              <ChevronDown size={14} className={`sap-chevron ${isSessionDropdownOpen ? 'open' : ''}`} />
            </button>

            {isSessionDropdownOpen && (
              <div className="sap-session-dropdown-menu">
                <div className="sap-session-dropdown-header">
                  <span>SAP GUI Sessions</span>
                  <span className="sap-session-count-badge">
                    {sapSession.sessions?.length || 0} active
                  </span>
                </div>

                {sapSession.code === 'SELECTED_SESSION_UNAVAILABLE' && (
                  <div className="sap-session-alert-banner">
                    <AlertTriangle size={14} />
                    <span>Selected session disconnected. Please choose an active session:</span>
                  </div>
                )}

                <div className="sap-session-list">
                  {sapSession.sessions && sapSession.sessions.length > 0 ? (
                    sapSession.sessions.map((sess) => {
                      const isSelected = sess.id === sapSession.selectedSessionId || sess.selected;
                      return (
                        <button
                          key={sess.id}
                          type="button"
                          className={`sap-session-item ${isSelected ? 'selected' : ''}`}
                          onClick={() => handleSelectSession(sess.id)}
                          disabled={isSwitchingSession}
                        >
                          <span className="sap-session-radio">
                            {isSelected ? '●' : '○'}
                          </span>
                          <div className="sap-session-item-content">
                            <div className="sap-session-item-top">
                              <strong className="sap-session-item-user">{sess.user}</strong>
                              <span className="sap-session-item-env">
                                {sess.system} / {sess.client}
                              </span>
                              {isSelected && (
                                <span className="sap-session-active-pill">Selected</span>
                              )}
                            </div>
                            <div className="sap-session-item-sub">
                              <span className="sap-session-item-title">
                                {sess.title || sess.transaction || 'SAP Easy Access'}
                              </span>
                              <span className={`sap-session-item-status ${sess.busy ? 'busy' : 'ready'}`}>
                                {sess.busy ? 'Busy' : 'Ready'}
                              </span>
                            </div>
                          </div>
                        </button>
                      );
                    })
                  ) : (
                    <div className="sap-session-empty">
                      <p>No active SAP GUI sessions found.</p>
                      <small>Please open SAP GUI and log into a client.</small>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Dynamic SAP Session Status Badge */}
          <span
            className={`sap-session-pill status-${(sapSession.status || 'checking').toLowerCase()} ${
              sapSession.code === 'SELECTED_SESSION_UNAVAILABLE' ? 'status-selected_session_unavailable' : ''
            }`}
            title={sapSession.message || `SAP Status: ${sapSession.status}`}
            onClick={
              sapSession.code === 'SELECTED_SESSION_UNAVAILABLE'
                ? () => setIsSessionDropdownOpen(true)
                : undefined
            }
            style={sapSession.code === 'SELECTED_SESSION_UNAVAILABLE' ? { cursor: 'pointer' } : {}}
          >
            <span className={`sap-status-dot dot-${sapSession.connected ? 'connected' : (sapSession.status || 'checking').toLowerCase()}`}></span>
            {sapSession.mode === 'RFC' && sapSession.connected ? (
              <span>SAP RFC ONLINE {sapSession.latencyMs ? `(${sapSession.latencyMs}ms)` : ''}</span>
            ) : sapSession.code === 'SELECTED_SESSION_UNAVAILABLE' ? (
              <span>SELECTED SESSION DISCONNECTED</span>
            ) : sapSession.status === 'CONNECTED' || sapSession.status === 'AVAILABLE' ? (
              <span>SAP CONNECTED</span>
            ) : sapSession.status === 'CHECKING' ? (
              <span>CHECKING SAP...</span>
            ) : sapSession.status === 'BUSY' ? (
              <span>SAP BUSY</span>
            ) : sapSession.status === 'SERVER_UNAVAILABLE' ? (
              <span>SAP SERVER UNAVAILABLE</span>
            ) : sapSession.status === 'DISCONNECTED' || sapSession.status === 'SESSION_NOT_FOUND' ? (
              <span>SAP DISCONNECTED</span>
            ) : (
              <span>SAP {sapSession.status}</span>
            )}
          </span>

          {/* Logout Button */}
          <button
            type="button"
            className="sap-btn sap-btn-ghost sap-logout-btn"
            onClick={handleLogout}
            title="End session and log out"
          >
            <LogOut size={15} />
            <span>Logout</span>
          </button>
        </div>

        {/* Mobile menu toggle button */}
        <button
          type="button"
          className="sap-mobile-menu-btn"
          onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          aria-label={isMobileMenuOpen ? 'Close menu' : 'Open navigation menu'}
          aria-expanded={isMobileMenuOpen}
        >
          {isMobileMenuOpen ? <X size={22} /> : <Menu size={22} />}
        </button>

        {/* Mobile Dropdown Menu */}
        {isMobileMenuOpen && (
          <div className="sap-mobile-dropdown">
            <div className="sap-mobile-user-info">
              <User size={16} color="#94a3b8" />
              <span>Signed in as <strong>{sapSession.selectedUser || sapSession.user || user.username}</strong></span>
              <span
                className={`sap-session-pill status-${(sapSession.status || 'checking').toLowerCase()} ${
                  sapSession.code === 'SELECTED_SESSION_UNAVAILABLE' ? 'status-selected_session_unavailable' : ''
                }`}
                style={{ marginLeft: 'auto', fontSize: '10px', padding: '2px 8px' }}
                title={sapSession.message || `SAP Status: ${sapSession.status}`}
              >
                <span className={`sap-status-dot dot-${(sapSession.status || 'checking').toLowerCase()}`}></span>
                {sapSession.code === 'SELECTED_SESSION_UNAVAILABLE' ? 'SESSION DISCONNECTED' : sapSession.status === 'CONNECTED' ? 'CONNECTED' : sapSession.status === 'BUSY' ? 'BUSY' : sapSession.status === 'SERVER_UNAVAILABLE' ? 'SERVER UNAVAIL' : 'DISCONNECTED'}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px' }}>
              <span style={{ fontSize: '12px', color: '#94a3b8' }}>System:</span>
              <select
                value={currentSystem}
                onChange={(e) => setCurrentSystem(e.target.value)}
                className={`sap-system-select ${currentSystem === 'PROD' ? 'prod' : ''}`}
                style={{ flex: 1 }}
              >
                <option value="DEV">DEV (Sandbox)</option>
                <option value="QA">QA (Quality)</option>
                <option value="PROD">PROD (Production)</option>
              </select>
            </div>

            {/* Mobile Session Selector */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 12px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              <span style={{ fontSize: '12px', color: '#94a3b8' }}>SAP GUI Session:</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {sapSession.sessions && sapSession.sessions.length > 0 ? (
                  sapSession.sessions.map((sess) => {
                    const isSelected = sess.id === sapSession.selectedSessionId || sess.selected;
                    return (
                      <button
                        key={sess.id}
                        type="button"
                        className={`sap-session-item ${isSelected ? 'selected' : ''}`}
                        onClick={() => handleSelectSession(sess.id)}
                        disabled={isSwitchingSession}
                        style={{ padding: '6px 10px', fontSize: '12px', textAlign: 'left' }}
                      >
                        <span className="sap-session-radio">{isSelected ? '●' : '○'}</span>
                        <span style={{ fontWeight: 600, color: '#f8fafc' }}>{sess.user}</span>
                        <span style={{ color: '#94a3b8', fontSize: '11px' }}>({sess.system}/{sess.client})</span>
                        {isSelected && <span className="sap-session-active-pill" style={{ marginLeft: 'auto' }}>Active</span>}
                      </button>
                    );
                  })
                ) : (
                  <span style={{ fontSize: '12px', color: '#94a3b8' }}>No active sessions</span>
                )}
              </div>
            </div>

            <button
              type="button"
              className="sap-btn sap-btn-secondary sap-mobile-action-btn"
              onClick={() => {
                setIsMobileMenuOpen(false);
                handleLogout();
              }}
              style={{ color: '#ef4444', borderColor: '#fca5a5' }}
            >
              <LogOut size={16} />
              <span>Log Out</span>
            </button>
          </div>
        )}
      </header>

      {/* Main Assistant View */}
      <main className="sap-assistant-layout">
        <div className="sap-assistant-container">
          <ChatBox
            isActive={true}
            systemKey={currentSystem}
          />
        </div>
      </main>
    </div>
  );
}
