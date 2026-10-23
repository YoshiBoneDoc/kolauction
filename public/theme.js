// Run before the stylesheet/app to avoid a bright flash for dark-mode users.
(function () {
    var theme;
    try { theme = localStorage.getItem('khub-theme'); } catch (_) { /* Storage may be disabled. */ }
    if (theme !== 'light' && theme !== 'dark') {
        theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
}());
