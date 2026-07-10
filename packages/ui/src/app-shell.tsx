import React from 'react';

/**
 * AppShell — viewport-clamped layout primitive
 *
 * Clamp contract:
 *   - Header / Footer: shrink-0  (they stay pinned, never squish)
 *   - Body:            flex-1 min-h-0 overflow-auto  (fills remaining space, scrolls)
 *
 * This prevents headers (e.g. nav + search bar) from pushing content off-screen
 * on small viewports. Each pane in a Split should repeat the same Header/Body/Footer
 * pattern for per-pane clamping.
 */

/* ------------------------------------------------------------------ */
/* AppShell root                                                       */
/* ------------------------------------------------------------------ */

export interface AppShellProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
}

const AppShellRoot = React.forwardRef<HTMLDivElement, AppShellProps>(
  function AppShell({ className = '', children, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={`h-dvh flex flex-col overflow-hidden ${className}`}
        {...props}
      >
        {children}
      </div>
    );
  }
);

/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

export interface AppShellHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
}

export const AppShellHeader = React.forwardRef<HTMLDivElement, AppShellHeaderProps>(
  function AppShellHeader({ className = '', children, ...props }, ref) {
    return (
      <div ref={ref} className={`shrink-0 ${className}`} {...props}>
        {children}
      </div>
    );
  }
);

/* ------------------------------------------------------------------ */
/* Body (scrollable content area)                                      */
/* ------------------------------------------------------------------ */

export interface AppShellBodyProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
}

export const AppShellBody = React.forwardRef<HTMLDivElement, AppShellBodyProps>(
  function AppShellBody({ className = '', children, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={`flex-1 min-h-0 overflow-auto ${className}`}
        {...props}
      >
        {children}
      </div>
    );
  }
);

/* ------------------------------------------------------------------ */
/* Footer                                                              */
/* ------------------------------------------------------------------ */

export interface AppShellFooterProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
}

export const AppShellFooter = React.forwardRef<HTMLDivElement, AppShellFooterProps>(
  function AppShellFooter({ className = '', children, ...props }, ref) {
    return (
      <div ref={ref} className={`shrink-0 ${className}`} {...props}>
        {children}
      </div>
    );
  }
);

/* ------------------------------------------------------------------ */
/* Split (horizontal panes)                                            */
/* ------------------------------------------------------------------ */

export interface AppShellSplitProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
}

export const AppShellSplit = React.forwardRef<HTMLDivElement, AppShellSplitProps>(
  function AppShellSplit({ className = '', children, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={`flex-1 min-h-0 flex flex-row overflow-hidden ${className}`}
        {...props}
      >
        {children}
      </div>
    );
  }
);

/* ------------------------------------------------------------------ */
/* Split.Pane                                                          */
/* ------------------------------------------------------------------ */

export interface AppShellPaneProps extends React.HTMLAttributes<HTMLDivElement> {
  width?: string | number;
  children?: React.ReactNode;
}

export const AppShellPane = React.forwardRef<HTMLDivElement, AppShellPaneProps>(
  function AppShellPane({ width, className = '', style, children, ...props }, ref) {
    const widthStyle = width == null  ? style : { width, ...style };
    return (
      <div
        ref={ref}
        className={`flex flex-col min-h-0 overflow-hidden ${className}`}
        style={widthStyle}
        {...props}
      >
        {children}
      </div>
    );
  }
);

AppShellRoot.displayName = 'AppShell';
AppShellHeader.displayName = 'AppShell.Header';
AppShellBody.displayName = 'AppShell.Body';
AppShellFooter.displayName = 'AppShell.Footer';
AppShellSplit.displayName = 'AppShell.Split';
AppShellPane.displayName = 'AppShell.Split.Pane';

/* Compound API — typed so consumers get AppShell.Header, AppShell.Split.Pane, etc. */
const AppShellSplitCompound = Object.assign(AppShellSplit, { Pane: AppShellPane });

export const AppShell = Object.assign(AppShellRoot, {
  Header: AppShellHeader,
  Body: AppShellBody,
  Footer: AppShellFooter,
  Split: AppShellSplitCompound,
});
