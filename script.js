const API = "http://localhost:3000";
let token = localStorage.getItem("token");

// ADDED: simple API wrapper to auto-refresh expired tokens
async function apiFetch(url, options = {}) {
  options.headers = options.headers || {};
  if (token) options.headers["Authorization"] = `Bearer ${token}`;
  let res = await fetch(url, options);
  if (res.status === 401 && localStorage.getItem("refreshToken")) {
    // try refresh
    const rt = localStorage.getItem("refreshToken");
    const r = await fetch(`${API}/token/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: rt })
    });
    if (r.ok) {
      const data = await r.json();
      token = data.token;
      localStorage.setItem("token", token);
      options.headers["Authorization"] = `Bearer ${token}`;
      res = await fetch(url, options); // retry once
    } else {
      logout();
    }
  }
  return res;
}

/* ---------- AUTH ---------- */
async function signup() {
  const name = document.getElementById("signup-name").value.trim();
  const email = document.getElementById("signup-email").value.trim();
  const password = document.getElementById("signup-password").value.trim();

  if (!name || !email || !password) {
    alert("All fields are required!");
    return;
  }

  try {
    const res = await fetch(`${API}/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password })
    });
    if (res.ok) {
      alert("Signup successful! Please login.");
      window.location.href = "login.html";
    } else {
      const error = await res.text();
      alert("Signup failed: " + error);
    }
  } catch (error) {
    console.error(error);
    alert("Error signing up.");
  }
}

async function login() {
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value.trim();

  if (!email || !password) {
    alert("Email and password required!");
    return;
  }

  try {
    const res = await fetch(`${API}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });

    if (res.ok) {
      const data = await res.json();
      localStorage.setItem("token", data.token);
      localStorage.setItem("refreshToken", data.refreshToken); // ADDED
      localStorage.setItem("userId", data.userId); // ADDED (for socket)
      token = data.token;
      window.location.href = "dashboard.html";
    } else {
      const error = await res.text();
      alert("Login failed: " + error);
    }
  } catch (error) {
    console.error(error);
    alert("Error logging in.");
  }
}

function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("refreshToken");
  localStorage.removeItem("userId");
  token = null;
  window.location.href = "login.html";
}

/* ---------- TASKS ---------- */
async function addTask() {
  const title = document.getElementById("task-title").value.trim();
  const description = document.getElementById("task-desc").value.trim();
  const date = document.getElementById("task-date").value;
  const time = document.getElementById("task-time").value;
  const priority = document.getElementById("task-priority")?.value || "Medium"; // ADDED

  const deadline = date && time ? `${date} ${time}` : date;

  if (!title || !deadline) {
    alert("Task name and deadline are required!");
    return;
  }

  try {
    const res = await apiFetch(`${API}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description, deadline, priority })
    });

    if (res.ok) {
      closeTaskModal();
      loadTasks();
      resetAddForm();
    } else {
      const error = await res.text();
      alert("Failed to add task: " + error);
    }
  } catch (error) {
    console.error(error);
    alert("Error adding task.");
  }
}

function resetAddForm(){
  ["task-title","task-desc","task-date","task-time"].forEach(id=>{ const el = document.getElementById(id); if (el) el.value = "" });
  const p = document.getElementById("task-priority"); if (p) p.value = "Medium";
}

async function loadTasks(filters = {}) {
  try {
    const params = new URLSearchParams();
    if (filters.q) params.set('q', filters.q);
    if (filters.status && filters.status !== 'All') params.set('status', filters.status);

    const res = await apiFetch(`${API}/tasks?${params.toString()}`, { headers: {} });
    const tasks = await res.json();
    const taskList = document.getElementById("task-list");
    taskList.innerHTML = "";

    let completed = 0;

    tasks.forEach(task => {
      if (task.status === "Completed") completed++;

      const li = document.createElement("div");
      li.className = "task-item";

      li.innerHTML = `
        <span>
          <strong>${task.title}</strong> - ${task.status}
          ${task.priority ? `<span class="priority-badge ${task.priority.toLowerCase()}">${task.priority}</span>` : ''}
          ${task.deadline ? `<small> ⏰ ${task.deadline}</small>` : ''}
          ${task.description ? `<div class="task-desc">${task.description}</div>` : ''}
        </span>
        <span class="task-actions">
          <button class="complete-btn" title="Mark complete" onclick="markCompleted(${task.id})">✔️</button>
          <button class="edit-btn" title="Edit task" onclick="openEditTaskModal(${task.id})">✏️</button>
          <button class="delete-btn" title="Delete task" onclick="deleteTask(${task.id})">🗑️</button>
        </span>
      `;
      taskList.appendChild(li);
    });

    updateCharts(completed, tasks.length); // ADDED charts
  } catch (error) {
    console.error(error);
  }
}

async function markCompleted(id) {
  try {
    const res = await apiFetch(`${API}/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "Completed" })
    });
    if (res.ok) loadTasks(currentFilters());
  } catch (error) { console.error(error); }
}

async function deleteTask(id) {
  try {
    const res = await apiFetch(`${API}/tasks/${id}`, { method: "DELETE" });
    if (res.ok) loadTasks(currentFilters());
  } catch (error) { console.error(error); }
}

// ADDED: Edit Task
let editingTaskId = null;
function openEditTaskModal(id) {
  editingTaskId = id;
  document.getElementById("edit-task-modal").style.display = "flex";
  // Optional: Pre-fill data by reading DOM or reloading single task (kept simple)
}
function closeEditTaskModal() {
  editingTaskId = null;
  document.getElementById("edit-task-modal").style.display = "none";
}
async function saveTaskEdits(){
  if (!editingTaskId) return;
  const title = document.getElementById("edit-task-title").value.trim();
  const description = document.getElementById("edit-task-desc").value.trim();
  const date = document.getElementById("edit-task-date").value;
  const time = document.getElementById("edit-task-time").value;
  const priority = document.getElementById("edit-task-priority")?.value || "Medium";
  const deadline = date && time ? `${date} ${time}` : date;

  const payload = {};
  if (title) payload.title = title;
  if (description) payload.description = description;
  if (deadline) payload.deadline = deadline;
  payload.priority = priority;

  try {
    const res = await apiFetch(`${API}/tasks/${editingTaskId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      closeEditTaskModal();
      loadTasks(currentFilters());
    } else {
      alert("Failed to update task");
    }
  } catch(e){ console.error(e); }
}

/* ---------- SEARCH & FILTER ---------- */
function currentFilters(){
  return {
    q: document.getElementById('task-search')?.value || '',
    status: document.getElementById('task-status-filter')?.value || 'All'
  };
}
function setupSearchFilter(){
  const search = document.getElementById('task-search');
  const status = document.getElementById('task-status-filter');
  if (search) search.addEventListener('input', ()=>loadTasks(currentFilters()));
  if (status) status.addEventListener('change', ()=>loadTasks(currentFilters()));
}

/* ---------- CHARTS (Chart.js) ---------- */
let doughnutChart, barChart;
function updateCharts(completed, total){
  const pending = Math.max(total - completed, 0);

  // Doughnut (Completed vs Pending)
  const doughnutCtx = document.getElementById('taskChart');
  if (doughnutCtx) {
    if (doughnutChart) doughnutChart.destroy();
    doughnutChart = new Chart(doughnutCtx, {
      type: 'doughnut',
      data: { labels: ['Completed','Pending'], datasets: [{ data: [completed, pending] }] },
      options: { responsive: true, plugins:{ legend: { position: 'bottom' } } }
    });
  }

  // Bar (Daily productivity) – simple example using last 7 days aggregated by status
  const barCtx = document.getElementById('dailyChart');
  if (barCtx) {
    // For demo, compute percentages; for real, request an endpoint
    const labels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const data = [completed, pending, 0, 0, 0, 0, 0]; // placeholder trend
    if (barChart) barChart.destroy();
    barChart = new Chart(barCtx, {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Tasks', data }] },
      options: { responsive: true, plugins:{ legend: { display: false } } }
    });
  }
}

/* ---------- PROFILE ---------- */
async function loadProfile() {
  try {
    const res = await apiFetch(`${API}/profile`);
    const profile = await res.json();

    if (document.getElementById("profile-name")) {
      // on profile page – input vs textContent (your original used textContent)
      const nameInput = document.getElementById("profile-name");
      if (nameInput.tagName === 'INPUT') nameInput.value = profile.name;
      else nameInput.textContent = profile.name;
      document.getElementById("profile-email").textContent = profile.email;
      document.getElementById("profile-points").textContent = profile.points || 0;
      document.getElementById("tasks-pending").textContent = profile.pending || 0;
      document.getElementById("tasks-completed").textContent = profile.completed || 0;
      document.getElementById("profile-pic").src = profile.profilePic || "https://via.placeholder.com/100";
    }

    // show on dashboard header (ADDED)
    const navPic = document.getElementById("nav-profile-pic");
    if (navPic) navPic.src = profile.profilePic || "https://via.placeholder.com/40";

  } catch (error) { console.error(error); }
}

// ADDED: change email/password
async function changePassword(){
  const curr = document.getElementById('current-password')?.value || '';
  const next = document.getElementById('new-password')?.value || '';
  if (!next) return alert("New password required");
  // backend only requires new password; you can verify current on front/back in future
  const res = await apiFetch(`${API}/profile`, {
    method: 'PUT',
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: next })
  });
  if (res.ok) alert("Password updated");
  else alert("Failed to update password");
}
async function updateEmail(){
  const email = document.getElementById('new-email')?.value || '';
  if (!email) return alert("Email required");
  const res = await apiFetch(`${API}/profile`, {
    method: 'PUT',
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email })
  });
  if (res.ok) alert("Email updated");
  else alert("Failed to update email");
}

/* ---------- LEADERBOARD ---------- */
async function loadLeaderboard() {
  try {
    const friendsOnly = document.getElementById('friends-only')?.checked ? 'true' : 'false';
    const res = await apiFetch(`${API}/leaderboard?friendsOnly=${friendsOnly}`);
    const leaderboard = await res.json();

    const container = document.getElementById("leaderboard-container");
    container.innerHTML = "";

    leaderboard.forEach((user, index) => {
      let medal = "";
      if (index === 0) medal = "🥇";
      else if (index === 1) medal = "🥈";
      else if (index === 2) medal = "🥉";

      const div = document.createElement("div");
      div.className = "leaderboard-box";
      div.innerHTML = `
        <span class="medal">${medal}</span>
        <h3>${user.name}</h3>
        <p>Email: ${user.email}</p>
        <p>Completed: ${user.completed || 0}</p>
        <p>Incomplete: ${user.incomplete || 0}</p>
      `;
      container.appendChild(div);
    });
  } catch (error) {
    console.error(error);
  }
}

// ADDED: friends
async function sendFriendRequest(){
  const email = document.getElementById('friend-email')?.value || '';
  if (!email) return alert("Enter friend email");
  const res = await apiFetch(`${API}/friends/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ friendEmail: email })
  });
  if (res.ok) alert("Friend request sent");
  else alert("Failed to send request");
}
async function loadFriendRequests(){
  const list = document.getElementById('friend-requests');
  if (!list) return;
  const res = await apiFetch(`${API}/friends/requests`);
  const items = await res.json();
  list.innerHTML = '';
  items.forEach(u=>{
    const li = document.createElement('li');
    li.textContent = `${u.name} (${u.email}) `;
    const btn = document.createElement('button');
    btn.textContent = 'Accept';
    btn.onclick = async ()=>{
      const r = await apiFetch(`${API}/friends/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: u.id })
      });
      if (r.ok) { alert('Accepted'); loadFriendRequests(); }
    };
    li.appendChild(btn);
    list.appendChild(li);
  });
}

/* ---------- MODALS ---------- */
function openTaskModal() {
  document.getElementById("task-modal").style.display = "flex";
}
function closeTaskModal() {
  document.getElementById("task-modal").style.display = "none";
}

/* ---------- REALTIME (optional) ---------- */
function initSocket(){
  if (!window.io || !localStorage.getItem('userId')) return;
  const socket = io(API, { transports: ['websocket'] });
  socket.emit('register', localStorage.getItem('userId'));
  socket.on('friendActivity', (evt)=>{
    // simple popup
    const n = document.createElement('div');
    n.className = 'toast';
    n.textContent = `Your friend completed a task! 🎉`;
    document.body.appendChild(n);
    setTimeout(()=>n.remove(), 4000);
  });
}

/* ---------- INIT ---------- */
document.addEventListener("DOMContentLoaded", () => {
  if (window.location.pathname.endsWith("dashboard.html")) {
    if (!token) window.location.href = "login.html";
    setupSearchFilter();
    loadProfile(); // show profile pic
    loadTasks(currentFilters());
    if (window.io) initSocket();
  }
  if (window.location.pathname.endsWith("profile.html")) {
    if (!token) window.location.href = "login.html";
    loadProfile();
  }
  if (window.location.pathname.endsWith("leaderboard.html")) {
    if (!token) window.location.href = "login.html";
    loadLeaderboard();
    loadFriendRequests();
    const chk = document.getElementById('friends-only');
    if (chk) chk.addEventListener('change', loadLeaderboard);
  }
});
