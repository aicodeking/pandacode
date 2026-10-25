import { paletteTerminal } from './palette';
import { call, subscribe } from './bridge';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { currentTheme } from './theme';
import { textScale } from './ui-size';
      ? t('Uses Kimi’s saved permissions. Review them in the console before pressing Enter.')
      : command ? t('When the console is ready, insert the command and press Enter.') : t('Native harness console. Type a command to continue.');
    hint.style.cssText = 'color:var(--muted);font-size:.78rem;flex:1';
