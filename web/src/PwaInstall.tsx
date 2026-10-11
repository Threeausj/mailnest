import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Download, Laptop, Smartphone } from 'lucide-react';
import { Modal } from './components';
import type { InstallPrompt } from './types';

export interface PwaInstallController {
  installed: boolean;
  busy: boolean;
  canPrompt: boolean;
  secure: boolean;
  guideOpen: boolean;
  status: string;
  requestInstall: () => Promise<void>;
  closeGuide: () => void;
}

function inAppWindow() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function usePwaInstall(): PwaInstallController {
  const [installed, setInstalled] = useState(inAppWindow);
  const [busy, setBusy] = useState(false);
  const [canPrompt, setCanPrompt] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [status, setStatus] = useState('');
  const promptRef = useRef<InstallPrompt | null>(null);
  const busyRef = useRef(false);
  const installedRef = useRef(installed);
  const secure = window.isSecureContext;

  useEffect(() => {
    const displayMode = window.matchMedia('(display-mode: standalone)');
    const onPrompt = (event: Event) => {
      event.preventDefault();
      if (installedRef.current) return;
      promptRef.current = event as InstallPrompt;
      setCanPrompt(true);
      setStatus('');
    };
    const onInstalled = () => {
      installedRef.current = true;
      promptRef.current = null;
      setInstalled(true);
      setCanPrompt(false);
      setGuideOpen(false);
      setStatus('邮屿已安装，可从桌面或应用列表打开。');
    };
    const onDisplayMode = () => {
      if (inAppWindow()) onInstalled();
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    displayMode.addEventListener('change', onDisplayMode);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      displayMode.removeEventListener('change', onDisplayMode);
    };
  }, []);

  const closeGuide = useCallback(() => setGuideOpen(false), []);
  const requestInstall = useCallback(async () => {
    if (busyRef.current) return;
    if (installedRef.current) {
      setStatus('邮屿已安装，可从桌面或应用列表打开。');
      setGuideOpen(true);
      return;
    }
    const prompt = promptRef.current;
    if (!secure || !prompt) {
      setGuideOpen(true);
      return;
    }
    // Each browser install event can be used only once. Clear it before awaiting
    // so two entry points cannot reuse the same native prompt.
    promptRef.current = null;
    busyRef.current = true;
    setCanPrompt(false);
    setBusy(true);
    setStatus('');
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (installedRef.current) return;
      setStatus(choice.outcome === 'accepted'
        ? '已确认安装，完成后可从桌面或应用列表打开邮屿。'
        : '已取消安装，你可以稍后再试，或通过浏览器菜单安装。');
      setGuideOpen(true);
    } catch {
      setStatus('未能打开安装窗口，请通过浏览器菜单安装，或刷新页面后重试。');
      setGuideOpen(true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [secure]);

  return { installed, busy, canPrompt, secure, guideOpen, status, requestInstall, closeGuide };
}

export function PwaInstallButton({ install, className = 'button primary', label = '安装应用', iconOnly = false, role, tabIndex }: {
  install: PwaInstallController;
  className?: string;
  label?: string;
  iconOnly?: boolean;
  role?: 'button' | 'menuitem';
  tabIndex?: number;
}) {
  const text = install.installed ? '已安装' : install.busy ? '安装中…' : label;
  const Icon = install.installed ? Check : Download;
  return <button type="button" className={className} aria-label={text} title={text} role={role} tabIndex={tabIndex}
    disabled={install.busy || install.installed} onClick={() => void install.requestInstall()}>
    <Icon size={17} aria-hidden="true" className={install.busy ? 'spinning' : ''} />
    {!iconOnly && <span>{text}</span>}
  </button>;
}

export function PwaInstallGuide({ install, inline = false }: { install: PwaInstallController; inline?: boolean }) {
  if (!install.guideOpen) return null;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(navigator.userAgent);
  const content = <div className="pwa-install-content">
    {install.status && <p className="pwa-install-status" role="status">{install.status}</p>}
    {!install.secure && <div className="hint-panel pwa-install-notice"><Smartphone size={19} />
      <span>当前地址使用 HTTP，暂时无法安装完整的 PWA 应用。请使用 HTTPS 地址后重新打开邮屿。现在可通过浏览器菜单添加桌面快捷方式，快捷方式不提供离线和后台邮件提醒。</span>
    </div>}
    {install.installed ? <p>邮屿已安装，可直接从桌面或应用列表打开。</p> : <>
      {install.secure && !install.status && <p>浏览器暂未提供一键安装，请按以下方式操作。如果已安装，可直接从桌面打开邮屿。</p>}
      <ol className="pwa-install-steps">
        {ios ? <>
          <li>使用 Safari 打开邮屿。</li>
          <li>点击「分享」→「添加到主屏幕」，按屏幕提示确认。</li>
        </> : android ? <>
          <li>点击浏览器右上角的「⋮」菜单。</li>
          <li>选择「安装应用」或「添加到主屏幕」，按屏幕提示确认。</li>
        </> : <>
          <li>在 Chrome 或 Edge 中打开邮屿。</li>
          <li>点击地址栏的安装图标，或浏览器菜单中的「安装应用」；若仅有创建快捷方式选项，可先添加快捷方式。</li>
        </>}
      </ol>
      <p className="small-muted">安装后的应用可独立打开；读取新邮件、发送邮件仍需联网。</p>
    </>}
    <div className="pwa-install-actions">
      {install.secure && install.canPrompt && !install.installed && <PwaInstallButton install={install} />}
      <button type="button" className="button secondary" onClick={install.closeGuide}>知道了</button>
    </div>
  </div>;
  return inline ? <div className="pwa-install-inline" role="region" aria-label="安装邮屿">{content}</div> :
    <Modal title="安装邮屿" subtitle={ios || android ? '把邮箱放到主屏幕，随时打开。' : '在桌面上，给邮屿留一个位置。'} onClose={install.closeGuide}>
      <div className="pwa-install-intro">{ios || android ? <Smartphone size={23} /> : <Laptop size={23} />}<strong>邮屿 MailNest</strong></div>{content}
    </Modal>;
}
