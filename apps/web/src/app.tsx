/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Router, HashRouter, Route, useLocation } from '@solidjs/router';
import { ColorModeProvider } from '@kobalte/core';
import { Show, Suspense, createEffect, lazy, type JSX } from 'solid-js';
import { Toaster } from "@/components/ui/sonner";
import { AppContextMenu } from "@/components/app-context-menu";

import { AuthProvider, useAuth } from '@/context/auth';
import { PersistRoute } from '@/lib/persist-route';
import { EditorApi } from '@/dapi';
import { UpgradeDialog } from '@/components/upgrade-dialog';
import { PurchaseSuccess } from '@/components/purchase-success';
import { ScreenTooSmall } from '@/components/screen-too-small';
import { UnsupportedBrowser } from '@/components/unsupported-browser';
import { LoginPage } from '@/pages/login';
import { AuthCallbackPage } from '@/pages/auth-callback';
import { NotFoundPage } from '@/pages/not-found';
import { DashboardPage } from '@/pages/dashboard';
import { localMode } from '@/lib/local-mode';

const ProjectPage = lazy(() => import('@/pages/project').then(module => ({ default: module.ProjectPage })));

function AuthGate(props: { children: JSX.Element }) {
  const auth = useAuth();

  return (
    <Show when={!auth.isLoading()}>
      <Show when={localMode || auth.isAuthenticated()}>
        {props.children}
      </Show>
      <Show when={!localMode && !auth.isAuthenticated()}>
        <LoginPage />
      </Show>
    </Show>
  );
}

function BootSplash() {
  const auth = useAuth();

  createEffect(() => {
    if (auth.isLoading()) return;
    document.getElementById('boot-splash')?.remove();
  });

  return null;
}

function EnvironmentOverlays() {
  const location = useLocation();
  const onCheckoutPage = () => location.pathname.startsWith('/checkout');

  return (
    <Show when={!onCheckoutPage()}>
      <Show when={!localMode}><ScreenTooSmall /></Show>
      <UnsupportedBrowser />
    </Show>
  );
}

function App() {
  const RouterComponent = window.desktop ? HashRouter : Router;
  return (
    <RouterComponent
      root={(props) => (
        <ColorModeProvider initialColorMode="dark">
          <AppContextMenu>
            <AuthProvider>
              {props.children}
              <BootSplash />
              <Show when={!localMode}>
                <UpgradeDialog />
                <PurchaseSuccess />
              </Show>
              <EditorApi />
            </AuthProvider>
          </AppContextMenu>
          <Toaster />
          <EnvironmentOverlays />
          <PersistRoute />
        </ColorModeProvider>
      )}
    >
      <Route path="/auth/callback" component={AuthCallbackPage} />
      <Route path="/" component={() => <AuthGate><DashboardPage /></AuthGate>} />
      <Route path="/projects/*ref" component={() => (
        <AuthGate>
          <Suspense fallback={<div role="status" class="flex h-dvh items-center justify-center text-sm">Opening project...</div>}>
            <ProjectPage />
          </Suspense>
        </AuthGate>
      )} />
      <Route path="*404" component={NotFoundPage} />
    </RouterComponent>
  );
}

export default App;
