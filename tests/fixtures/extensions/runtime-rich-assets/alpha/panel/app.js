/* Asset board (R0302 fixture): relative modules, an image, its own page storage, and two failure canaries. */
import { format } from './lib/format.js';

/* The same key as the twin package: two origins keep two values. */
const STORAGE_KEY = 'panel-note';
const $ = id => document.getElementById(id);
$('module').textContent = `modules: ${format('loaded')}`;
$('origin').textContent = `origin: ${location.origin}`;
$('base').textContent = `base: ${window.pandaView?.baseUrl ?? 'none'}`;
const show = () => { $('stored').textContent = `stored: ${localStorage.getItem(STORAGE_KEY) ?? 'empty'}`; };
show();
$('save').addEventListener('click', () => { localStorage.setItem(STORAGE_KEY, $('note').value); show(); });
const logo = $('logo');
const loaded = () => { $('image').textContent = logo.naturalWidth > 0 ? 'image: loaded' : 'image: failed'; };
if (logo.complete) loaded(); else { logo.addEventListener('load', loaded); logo.addEventListener('error', loaded); }
/* A relative path that leaves the folder answers the host's 404 page inside the panel. */
$('outside').addEventListener('click', () => { location.href = '../extension.json'; });
/* An origin not listed in rich.remote: the shell stops the panel and offers a reload. */
$('undeclared').addEventListener('click', () => { location.href = 'https://undeclared.example.test/'; });
window.pandaView?.onDidInitialize(({ dto }) => { $('init').textContent = `init: ${dto.owner} ${dto.version} ${dto.windowId}`; });
