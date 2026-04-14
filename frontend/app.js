/**
 * Advanced Enterprise TeleMedicine Portal Frontend Logic
 * Incorporates Auth0 (SECaaS SPA SDK), Check-based RBAC, Video CPaaS, and Analytics
 */

let auth0Client = null;
let currentToken = null;
let profile = null;
let userRole = "PATIENT"; // Default
let chartInstances = {}; // Track charts to destroy them on update

// Auth0 Configuration parameters
const auth0Config = {
    domain: "dev-o05tr0k74su6r1as.jp.auth0.com",
    clientId: "2hkOvapMs9TmEwvIBUBkiAMMAMuZaIrg",
    authorizationParams: {
      redirect_uri: window.location.origin
    }
};

const mockAuth0Client = {
    loginWithRedirect: () => {
        localStorage.setItem("mockAuth_loggedIn", "true");
        window.location.reload();
    },
    logout: () => {
        localStorage.removeItem("mockAuth_loggedIn");
        window.location.reload();
    },
    isAuthenticated: async () => localStorage.getItem("mockAuth_loggedIn") === "true",
    getUser: async () => ({ 
        name: "Dr. Demo (Mock Auth)", 
        email: "doctor@hospital.com", // Used for mock RBAC
        picture: "https://ui-avatars.com/api/?name=Dr+Demo&background=0D8ABC&color=fff&size=128" 
    }),
    getTokenSilently: async () => "mock-jwt-token-12345",
    handleRedirectCallback: async () => {}
};

document.addEventListener("DOMContentLoaded", async () => {
    // Identity Elements
    const btnLogin = document.getElementById("btnLogin");
    const btnLogout = document.getElementById("btnLogout");
    const userProfile = document.getElementById("userProfile");
    const userName = document.getElementById("userName");
    const userAvatar = document.getElementById("userAvatar");
    const userRoleBadge = document.getElementById("userRoleBadge");
    const doctorIdInput = document.getElementById("doctorId");
    const appWrapper = document.getElementById("appWrapper");
    const unauthorizedState = document.getElementById("unauthorizedState");

    // 1. Initialize Auth0 (SECaaS)
    try {
        if (auth0Config.clientId === "YOUR_CLIENT_ID_PLACEHOLDER") {
            auth0Client = mockAuth0Client;
            if (localStorage.getItem("mockAuth_loggedIn") === "true") {
                showNotification("Running in SECaaS Bypass Mode.");
            }
        } else {
            auth0Client = await auth0.createAuth0Client(auth0Config);
            if (location.search.includes("state=") && 
                (location.search.includes("code=") || location.search.includes("error="))) {
                await auth0Client.handleRedirectCallback();
                window.history.replaceState({}, document.title, "/");
            }
        }

        const isAuthenticated = await auth0Client.isAuthenticated();
        if (isAuthenticated) {
            profile = await auth0Client.getUser();
            currentToken = await auth0Client.getTokenSilently().catch(() => null);
            
            // FEATURE 4: Role Based Access Control (RBAC) Simulation vs Real
            // Check for real Auth0 Roles added via Actions first
            const assignedRoles = profile["https://cloudnotes-api.com/roles"] || [];

            if (assignedRoles.length > 0) {
                // If Auth0 returned real roles, use them!
                if (assignedRoles.includes("Doctor")) userRole = "DOCTOR";
                else if (assignedRoles.includes("Admin")) userRole = "ADMIN";
                else userRole = "PATIENT";
            } else {
                // Fallback Simulation: If no roles in Auth0 yet, guess from email/name
                const checkStr = `${profile.email || ''} ${profile.name || ''} ${profile.nickname || ''}`.toLowerCase();
                
                if (checkStr.includes("admin")) {
                    userRole = "ADMIN";
                } else if (checkStr.includes("doctor") || checkStr.includes("dr.") || checkStr.includes("dr@") || checkStr.includes("dr_") || checkStr.startsWith("dr")) {
                    userRole = "DOCTOR";
                } else {
                    userRole = "PATIENT";
                }
            }

            showAuthenticatedUI();
            if(doctorIdInput) doctorIdInput.value = profile.name || profile.email;
        } else {
            showUnauthenticatedUI();
        }
    } catch (e) {
        console.error("Auth0 initialization error:", e);
        showUnauthenticatedUI();
    }

    btnLogin.addEventListener("click", () => {
        btnLogin.innerHTML = "Authenticating...";
        auth0Client.loginWithRedirect();
    });
    
    btnLogout.addEventListener("click", () => {
        auth0Client.logout({ logoutParams: { returnTo: window.location.origin } });
    });

    function showAuthenticatedUI() {
        btnLogin.classList.add("hidden");
        btnLogout.classList.remove("hidden");
        userProfile.classList.remove("hidden");
        appWrapper.classList.remove("hidden");
        unauthorizedState.classList.add("hidden");
        
        if(profile) {
           userName.innerText = profile.name || profile.email;
           userAvatar.src = profile.picture;
           userRoleBadge.innerText = userRole;
           
           // RBAC UI Config
           if(userRole === "DOCTOR" || userRole === "ADMIN") {
               document.getElementById("tab-doctor").classList.remove("hidden");
           }
           if(userRole === "ADMIN") {
               document.getElementById("tab-admin").classList.remove("hidden");
           }
        }
        
        // Initial Fetch
        fetchRecords();
    }
    
    function showUnauthenticatedUI() {
        btnLogin.classList.remove("hidden");
        btnLogout.classList.add("hidden");
        userProfile.classList.add("hidden");
        appWrapper.classList.add("hidden");
        unauthorizedState.classList.remove("hidden");
    }

    // Tabs Manager
    const tabs = ["tab-patient", "tab-doctor", "tab-video", "tab-admin"];
    const views = ["patient-view", "doctor-view", "video-view", "admin-view"];

    tabs.forEach((tabId, index) => {
        document.getElementById(tabId).addEventListener("click", () => {
            tabs.forEach(t => document.getElementById(t).classList.remove("active"));
            views.forEach(v => document.getElementById(v).classList.add("hidden"));
            
            document.getElementById(tabId).classList.add("active");
            document.getElementById(views[index]).classList.remove("hidden");

            // On-demand actions
            if(tabId === "tab-patient") fetchRecords();
            if(tabId === "tab-admin") fetchAnalytics(); // Feature 5
        });
    });

    function showNotification(message) {
        const notif = document.getElementById("notificationBanner");
        document.getElementById("notificationText").innerText = message;
        notif.classList.remove("hidden");
        notif.classList.add("slide-in");
        setTimeout(() => notif.classList.add("hidden"), 5000);
    }

    // --- FORM INGESTION LOGIC (FEATURE 2: CPaaS implicitly hit in backend) ---
    const ehrForm = document.getElementById("ehrForm");
    const fileInput = document.getElementById("medicalScan");
    const fileInfo = document.getElementById("fileInfo");
    const startDictationBtn = document.getElementById("startDictationBtn");
    
    if (startDictationBtn) {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SpeechRecognition) {
            const recognition = new SpeechRecognition();
            recognition.continuous = false; // Using pseudo-continuous via onend to avoid Chrome network timeouts
            recognition.interimResults = true;
            recognition.lang = 'en-US';
            
            let isDictating = false;

            startDictationBtn.addEventListener('click', (e) => {
                e.preventDefault();
                if (isDictating) {
                    isDictating = false;
                    recognition.stop();
                    startDictationBtn.innerHTML = "🎙️ Start Clinical AI Dictation";
                    startDictationBtn.style.background = "var(--secondary-color)";
                    return;
                }
                
                try {
                    isDictating = true;
                    recognition.start();
                    startDictationBtn.innerHTML = "🔴 Listening... (Click to Stop)";
                    startDictationBtn.style.background = "red";
                } catch (err) {
                    console.error("Dictation start error:", err);
                }
            });

            recognition.onresult = (event) => {
                let finalTranscript = '';
                for (let i = event.resultIndex; i < event.results.length; ++i) {
                    if (event.results[i].isFinal) {
                        finalTranscript += event.results[i][0].transcript;
                    }
                }
                if (finalTranscript) {
                    const diagnosisEl = document.getElementById('diagnosis');
                    diagnosisEl.value = diagnosisEl.value + (diagnosisEl.value && !diagnosisEl.value.endsWith(' ') ? ' ' : '') + finalTranscript;
                }
            };

            recognition.onerror = (event) => {
                console.error("Dictation error:", event.error);
                if (event.error === 'network') {
                    isDictating = false;
                    alert("AI Dictation Error: Network communication failed. Ensure you have an active internet connection (Web Speech API requires it).");
                }
                // Do not change UI here if it's going to restart, let onend handle the UI state.
            };

            recognition.onend = () => {
                if (isDictating) {
                    // Pseudo-continuous: start listening again immediately
                    try {
                        recognition.start();
                    } catch (e) {
                         isDictating = false;
                         startDictationBtn.innerHTML = "🎙️ Start Clinical AI Dictation";
                         startDictationBtn.style.background = "var(--secondary-color)";
                    }
                } else {
                    startDictationBtn.innerHTML = "🎙️ Start Clinical AI Dictation";
                    startDictationBtn.style.background = "var(--secondary-color)";
                }
            };
        } else {
            startDictationBtn.style.display = 'none';
        }
    }

    fileInput.addEventListener("change", (e) => {
        if(e.target.files.length > 0) {
            fileInfo.innerHTML = "<strong>📁 Selected:</strong> " + e.target.files[0].name;
            fileInfo.classList.remove("hidden");
        } else {
            fileInfo.classList.add("hidden");
        }
    });

    ehrForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const submitBtn = document.getElementById("submitBtn");
        submitBtn.disabled = true;
        submitBtn.innerHTML = 'Encrypting & Uploading...';

        const formData = new FormData();
        formData.append("patientName", document.getElementById("patientName").value);
        formData.append("diagnosis", document.getElementById("diagnosis").value);
        formData.append("doctorId", doctorIdInput.value);
        if (fileInput.files.length > 0) formData.append("medicalScan", fileInput.files[0]);

        try {
            const headers = {};
            if(currentToken) headers["Authorization"] = `Bearer ${currentToken}`;

            const response = await fetch("http://localhost:3000/api/ehr", {
                method: "POST",
                headers: headers,
                body: formData 
            });
            
            if (response.ok) {
                showNotification("EHR Saved & CPaaS notification triggered!");
                ehrForm.reset();
                fileInfo.classList.add("hidden");
            } else {
                alert("Failed to save EHR");
            }
        } catch (error) {
            console.error("Error creating record:", error);
            alert("Backend Connection Error.");
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '🌩️ Encrypt & Transmit to Cloud';
        }
    });

    // --- FETCH RECORDS ---
    async function fetchRecords() {
        const loadingSkeleton = document.getElementById("loadingSkeleton");
        const container = document.getElementById("recordsContainer");
        container.innerHTML = "";
        loadingSkeleton.classList.remove("hidden");

        try {
            const headers = {};
            if(currentToken) headers["Authorization"] = `Bearer ${currentToken}`;

            const response = await fetch("http://localhost:3000/api/ehr", { headers });
            let allRecords = await response.json();
            
            // Apply RBAC filters locally (In production, backend should filter this based on Auth0 token)
            if(userRole === "PATIENT") {
                // If patient, only show records where patientName matches their Auth0 name loosely
                allRecords = allRecords.filter(r => r.patientName.toLowerCase().includes((profile.name || '').toLowerCase().split(' ')[0]));
            }

            renderRecords(allRecords, container);
        } catch (error) {
            container.innerHTML = "<div class='error-state'>Error fetching records. Backend running?</div>";
        } finally {
            loadingSkeleton.classList.add("hidden");
        }
    }

    function renderRecords(records, container) {
        container.innerHTML = "";
        if (records.length === 0) {
            container.innerHTML = "<div class='empty-state'><p>No secure records found. (Patients only see their own records).</p></div>";
            return;
        }

        records.forEach(record => {
            const recordCard = document.createElement("div");
            recordCard.className = "record-card elegant-card";
            const dateStr = new Date(record.createdAt).toLocaleString();
            let attachmentHtml = record.scanUrl ? `<div class="attachment-action"><a href="${record.scanUrl}" target="_blank" class="cyber-btn" style="margin-right: 10px;">🎬 View S3 DICOM</a></div>` : '<div class="attachment-action"></div>';

            recordCard.innerHTML = `
                <div class="card-header cyber-header">
                  <h3><span class="avatar-circle">${record.patientName.charAt(0)}</span> ${record.patientName}</h3>
                  <span class="badge verified-badge">Decrypted</span>
                </div>
                <div class="card-body">
                    <p class="provider-info"><strong>Provider:</strong> ${record.doctorId}</p>
                    <div class="diagnosis-box enhanced-box"><p>${record.diagnosis}</p></div>
                </div>
                <div style="display: flex; gap: 10px;">
                  ${attachmentHtml}
                  <div class="attachment-action"><a href="http://localhost:3000/api/ehr/${record._id}/pdf" target="_blank" class="cyber-btn" style="background: var(--success-color);">📄 Download PDF Report</a></div>
                </div>
                <div class="footer cyber-footer"><small>${dateStr}</small></div>
            `;
            container.appendChild(recordCard);
        });
    }

    // --- FEATURE 3: JITSI MEET WEBRTC CPaaS ---
    document.getElementById("startVideoBtn").addEventListener("click", () => {
        const container = document.getElementById("jitsi-container");
        container.innerHTML = ""; // Clear button
        
        const domain = "meet.jit.si";
        const options = {
            roomName: "EnterpriseTeleMedRoom-" + Date.now(),
            width: "100%",
            height: "100%",
            parentNode: container,
            userInfo: {
                displayName: profile ? profile.name : "Guest",
            }
        };
        const api = new JitsiMeetExternalAPI(domain, options);
    });

    // --- FEATURE 5: ANALYTICS DASHBOARD ---
    async function fetchAnalytics() {
        try {
            const response = await fetch("http://localhost:3000/api/analytics");
            const data = await response.json();
            
            document.getElementById("kpi-total").innerText = data.totalRecords || 0;
            document.getElementById("kpi-storage").innerText = data.storageUsageGB ? data.storageUsageGB.toFixed(2) : 0;
            
            renderCharts(data);
        } catch (error) {
            console.error("Analytics fetch failed", error);
        }
    }

    function renderCharts(data) {
        if(chartInstances["intake"]) chartInstances["intake"].destroy();
        if(chartInstances["doctors"]) chartInstances["doctors"].destroy();

        // 1. Line Chart: Patient Intake over last days
        const intakeCtx = document.getElementById('intakeChart').getContext('2d');
        const labels = data.recentActivity ? data.recentActivity.map(x => x._id) : ['Mon','Tue','Wed','Thu'];
        const values = data.recentActivity ? data.recentActivity.map(x => x.count) : [1,3,2,5];

        chartInstances["intake"] = new Chart(intakeCtx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'New EHR Records',
                    data: values,
                    borderColor: '#0056b3',
                    tension: 0.3,
                    fill: true,
                    backgroundColor: 'rgba(0, 86, 179, 0.1)'
                }]
            }
        });

        // 2. Bar Chart: Consultations by Doctor
        const docCtx = document.getElementById('doctorChart').getContext('2d');
        const docLabels = data.recordsByDoctor ? data.recordsByDoctor.map(x => x._id) : ['Dr. Smith', 'Dr. Demo'];
        const docValues = data.recordsByDoctor ? data.recordsByDoctor.map(x => x.count) : [5, 10];

        chartInstances["doctors"] = new Chart(docCtx, {
            type: 'bar',
            data: {
                labels: docLabels,
                datasets: [{
                    label: 'Patients Handled',
                    data: docValues,
                    backgroundColor: '#4CAF50'
                }]
            }
        });
    }
});
