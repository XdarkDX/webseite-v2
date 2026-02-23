'use strict';

let csrfToken = '';
let currentLinks = [];
let originalLinks = [];

const el = {
  name: document.getElementById('nameInput'),
  bio: document.getElementById('bioInput'),
  footer: document.getElementById('footerInput'),
  accent: document.getElementById('accentInput'),
  avatarUpload: document.getElementById('avatarUpload'),
  logoUpload: document.getElementById('logoUpload'),
  saveProfileBtn: document.getElementById('saveProfileBtn'),
  linkForm: document.getElementById('linkForm'),
  linksList: document.getElementById('linksList'),
  saveLinksBtn: document.getElementById('saveLinksBtn'),
  cancelLinksBtn: document.getElementById('cancelLinksBtn'),
  logoutBtn: document.getElementById('logoutBtn'),
  toast: document.getElementById('toast')
};

async function init() {
  const res = await fetch('/api/admin/state', { headers: { 'Accept': 'application/json' } });
  if (res.status === 401) {
    window.location.href = '/admin/login';
    return;
  }
  if (!res.ok) {
    showToast('Laden fehlgeschlagen');
    return;
  }

  const state = await res.json();
  csrfToken = state.csrfToken || '';
  const profile = state.profile || {};
  el.name.value = profile.name || '';
  el.bio.value = profile.bio || '';
  el.footer.value = profile.footerText || '';
  el.accent.value = (profile.theme && profile.theme.accent) || '#3b82f6';

  currentLinks = Array.isArray(state.links) ? state.links : [];
  originalLinks = JSON.parse(JSON.stringify(currentLinks));
  renderLinks();
}

el.saveProfileBtn.addEventListener('click', async () => {
  const payload = {
    name: el.name.value,
    bio: el.bio.value,
    footerText: el.footer.value,
    theme: { accent: el.accent.value, background: 'navyGradient' }
  };

  const res = await apiPost('/api/admin/profile', payload);
  if (res.ok) showToast('Profil gespeichert');

  await uploadIfSelected('avatar', el.avatarUpload.files[0]);
  await uploadIfSelected('logo', el.logoUpload.files[0]);
});

el.linkForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const title = document.getElementById('linkTitle').value.trim();
  const subtitle = document.getElementById('linkSubtitle').value.trim();
  const url = document.getElementById('linkUrl').value.trim();
  const isActive = document.getElementById('linkActive').checked;
  const isFeatured = document.getElementById('linkFeatured').checked;

  if (!title || !/^https?:\/\//i.test(url)) {
    showToast('Bitte gültige URL (http/https) eingeben');
    return;
  }

  currentLinks.push({
    id: cryptoRandomId(),
    title,
    subtitle,
    url,
    isActive,
    isFeatured,
    order: currentLinks.length + 1
  });

  el.linkForm.reset();
  document.getElementById('linkActive').checked = true;
  renderLinks();
});

el.saveLinksBtn.addEventListener('click', async () => {
  normalizeOrder();
  const res = await apiPost('/api/admin/links', { links: currentLinks });
  if (res.ok) {
    originalLinks = JSON.parse(JSON.stringify(currentLinks));
    showToast('Links gespeichert');
  }
});

el.cancelLinksBtn.addEventListener('click', () => {
  currentLinks = JSON.parse(JSON.stringify(originalLinks));
  renderLinks();
  showToast('Änderungen zurückgesetzt');
});

el.logoutBtn.addEventListener('click', async () => {
  await apiPost('/api/auth/logout', {});
  window.location.href = '/admin/login';
});

function renderLinks() {
  normalizeOrder();
  el.linksList.innerHTML = '';

  if (!currentLinks.length) {
    el.linksList.innerHTML = '<p class="muted">Noch keine Links vorhanden.</p>';
    return;
  }

  currentLinks.forEach((link, index) => {
    const item = document.createElement('div');
    item.className = 'link-item';
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(link.title)}</strong>
        <p>${escapeHtml(link.subtitle || '')}</p>
        <p>${escapeHtml(link.url)}</p>
        <p>Active: ${link.isActive ? 'Ja' : 'Nein'} · Featured: ${link.isFeatured ? 'Ja' : 'Nein'}</p>
      </div>
      <div class="row-actions">
        <button class="btn-ghost" data-action="up" data-index="${index}">↑</button>
        <button class="btn-ghost" data-action="down" data-index="${index}">↓</button>
        <button class="btn-ghost" data-action="toggleActive" data-index="${index}">${link.isActive ? 'Deaktivieren' : 'Aktivieren'}</button>
        <button class="btn-ghost" data-action="toggleFeatured" data-index="${index}">${link.isFeatured ? 'Unfeature' : 'Feature'}</button>
        <button class="btn-ghost" data-action="edit" data-index="${index}">Edit</button>
        <button class="btn-ghost" data-action="delete" data-index="${index}">Löschen</button>
      </div>
    `;
    el.linksList.appendChild(item);
  });
}

el.linksList.addEventListener('click', (ev) => {
  const button = ev.target.closest('button[data-action]');
  if (!button) return;
  const index = Number(button.dataset.index);
  const action = button.dataset.action;

  if (Number.isNaN(index) || !currentLinks[index]) return;

  if (action === 'up' && index > 0) {
    [currentLinks[index - 1], currentLinks[index]] = [currentLinks[index], currentLinks[index - 1]];
  }
  if (action === 'down' && index < currentLinks.length - 1) {
    [currentLinks[index + 1], currentLinks[index]] = [currentLinks[index], currentLinks[index + 1]];
  }
  if (action === 'toggleActive') currentLinks[index].isActive = !currentLinks[index].isActive;
  if (action === 'toggleFeatured') currentLinks[index].isFeatured = !currentLinks[index].isFeatured;
  if (action === 'delete') currentLinks.splice(index, 1);
  if (action === 'edit') editLink(index);

  renderLinks();
});

function editLink(index) {
  const link = currentLinks[index];
  const title = prompt('Titel', link.title);
  if (title === null) return;
  const subtitle = prompt('Untertitel', link.subtitle || '');
  if (subtitle === null) return;
  const url = prompt('URL', link.url);
  if (url === null) return;
  if (!/^https?:\/\//i.test(url.trim())) {
    showToast('Ungültige URL');
    return;
  }
  link.title = title.trim().slice(0, 60);
  link.subtitle = subtitle.trim().slice(0, 120);
  link.url = url.trim();
}

async function uploadIfSelected(field, file) {
  if (!file) return;
  const formData = new FormData();
  formData.append('field', field);
  formData.append('file', file, file.name);

  const res = await fetch('/api/admin/upload', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrfToken },
    body: formData
  });

  if (!res.ok) {
    showToast(`${field} Upload fehlgeschlagen`);
  } else {
    showToast(`${field} Upload erfolgreich`);
  }
}

async function apiPost(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    showToast('Speichern fehlgeschlagen');
  }
  return res;
}

function normalizeOrder() {
  currentLinks.forEach((item, i) => {
    item.order = i + 1;
  });
}

function cryptoRandomId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return `id-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function showToast(message) {
  el.toast.textContent = message;
  el.toast.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => el.toast.classList.remove('show'), 1900);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

init();
