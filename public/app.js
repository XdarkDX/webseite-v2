'use strict';

const els = {
  avatar: document.getElementById('avatar'),
  logo: document.getElementById('logo'),
  name: document.getElementById('name'),
  bio: document.getElementById('bio'),
  links: document.getElementById('links'),
  footerText: document.getElementById('footerText')
};

async function loadPublic() {
  try {
    const res = await fetch('/api/public', { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('Request failed');
    const data = await res.json();

    const profile = data.profile || {};
    const links = Array.isArray(data.links) ? data.links : [];

    document.documentElement.style.setProperty('--accent', profile.theme && profile.theme.accent ? profile.theme.accent : '#3b82f6');

    els.avatar.src = profile.avatarUrl || 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTIwIiBoZWlnaHQ9IjEyMCIgdmlld0JveD0iMCAwIDEyMCAxMjAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3QgZmlsbD0iIzA4MjA0NCIgd2lkdGg9IjEyMCIgaGVpZ2h0PSIxMjAiIHJ4PSI2MCIvPjxjaXJjbGUgY3g9IjYwIiBjeT0iNDYiIHI9IjIyIiBmaWxsPSIjM2I4MmY2Ii8+PHBhdGggZD0iTTI2IDk4YzAtMjAuNCAxNS45LTM3IDM0LTM3aDAuMmMxOC4xIDAgMzQgMTYuNiAzNCAzN3YxMkgyNlY5OHoiIGZpbGw9IiMxMmM0ZmYiLz48L3N2Zz4=';
    els.name.textContent = profile.name || 'Mein Profil';
    els.bio.textContent = profile.bio || '';
    els.footerText.textContent = profile.footerText || '';

    if (profile.logoUrl) {
      els.logo.src = profile.logoUrl;
      els.logo.classList.remove('hidden');
    } else {
      els.logo.classList.add('hidden');
    }

    renderLinks(links);
  } catch (err) {
    els.links.innerHTML = '<p>Konnte Inhalte nicht laden.</p>';
  }
}

function renderLinks(links) {
  if (!links.length) {
    els.links.innerHTML = '<p class="bio">Noch keine Links veröffentlicht.</p>';
    return;
  }

  els.links.innerHTML = '';
  for (const link of links) {
    const a = document.createElement('a');
    a.className = 'link-card';
    a.href = link.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';

    const subtitle = link.subtitle ? `<div class="link-subtitle">${escapeHtml(link.subtitle)}</div>` : '';
    const badge = link.isFeatured ? '<span class="badge">Featured</span>' : '';

    a.innerHTML = `
      <div class="link-main">
        <div class="link-title">${escapeHtml(link.title)} ${badge}</div>
        ${subtitle}
      </div>
      <span class="arrow" aria-hidden="true">→</span>
    `;

    els.links.appendChild(a);
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

loadPublic();
