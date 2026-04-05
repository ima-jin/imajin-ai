export const themeInitScript = `
  (function() {
    var theme = localStorage.getItem('theme');
    if (theme === 'light') {
      document.documentElement.classList.remove('dark');
    } else {
      document.documentElement.classList.add('dark');
    }
  })()
`;
