/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { URL } from 'url';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { Configuration, readConfig } from '../common/contributionUtils';
import Dap from '../dap/api';
import { DebugSessionTunnels } from './debugSessionTunnels';

const localize = nls.loadMessageBundle();

const isTunnelForPort = (port: number) => (tunnel: vscode.TunnelDescription) =>
  typeof tunnel.localAddress === 'string'
    ? tunnel.localAddress.endsWith(`:${port}`)
    : tunnel.localAddress.port === port;

const tunnelRemoteServerIfNecessary = async (args: Dap.LaunchBrowserInCompanionEventParams) => {
  const urlStr = (args.params as { url?: string }).url;
  if (!urlStr) {
    return;
  }

  let url: URL;
  try {
    url = new URL(urlStr);
  } catch (e) {
    return;
  }

  if (!readConfig(vscode.workspace, Configuration.AutoServerTunnelOpen)) {
    return;
  }

  const port = Number(url.port) || 80;
  const tunnels = await vscode.workspace.tunnels;
  if (tunnels.some(isTunnelForPort(port))) {
    return;
  }

  try {
    await vscode.workspace.openTunnel({
      remoteAddress: { port, host: 'localhost' },
      localAddressPort: port,
    });
  } catch {
    // throws if already forwarded by user or by us previously
  }
};

const launchCompanionBrowser = async (
  session: vscode.DebugSession,
  sessionTunnels: DebugSessionTunnels,
  args: Dap.LaunchBrowserInCompanionEventParams,
) => {
  if (vscode.env.uiKind === vscode.UIKind.Web) {
    vscode.debug.stopDebugging(session);
    return vscode.window.showErrorMessage(
      localize(
        'cannotDebugInBrowser',
        "We can't launch a browser in debug mode from here. Open this workspace in VS Code on your desktop to enable debugging.",
      ),
    );
  }

  try {
    const [, tunnel] = await Promise.all([
      tunnelRemoteServerIfNecessary(args),
      sessionTunnels
        .request(session.id, {
          remotePort: args.serverPort,
          label: 'Browser Debug Tunnel',
        })
        .catch(() => undefined),
    ]);

    await vscode.commands.executeCommand('js-debug-companion.launchAndAttach', {
      proxyUri: tunnel ? `127.0.0.1:${tunnel.localAddress.port}` : `127.0.0.1:${args.serverPort}`,
      ...args,
    });
  } catch (e) {
    vscode.window.showErrorMessage(`Error launching browser: ${e.message || e.stack}`);
  }
};

const killCompanionBrowser = (
  session: vscode.DebugSession,
  tunnels: DebugSessionTunnels,
  { launchId }: Dap.KillCompanionBrowserEventParams,
) => {
  vscode.commands.executeCommand('js-debug-companion.kill', { launchId });
  tunnels.destroySession(session.id);
};

export function registerCompanionBrowserLaunch(context: vscode.ExtensionContext) {
  const tunnels = new DebugSessionTunnels();

  context.subscriptions.push(
    tunnels,
    vscode.debug.onDidReceiveDebugSessionCustomEvent(async event => {
      switch (event.event) {
        case 'launchBrowserInCompanion':
          return launchCompanionBrowser(event.session, tunnels, event.body);
        case 'killCompanionBrowser':
          return killCompanionBrowser(event.session, tunnels, event.body);
        default:
        // ignored
      }
    }),
  );
}
