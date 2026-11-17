/* Twin board (R0302 fixture): the same relative paths and the same storage key as the asset board, in another package. */
import { format } from './lib/format.js';

const STORAGE_KEY = 'panel-note';
const $ = id => document.getElementById(id);
$('module').textContent = `modules: ${format('loaded')}`;
$('origin').textContent = `origin: ${location.origin}`;
const show = () => { $('stored').textContent = `stored: ${localStorage.getItem(STORAGE_KEY) ?? 'empty'}`; };
show();
$('save').addEventListener('click', () => { localStorage.setItem(STORAGE_KEY, $('note').value); show(); });
