
(function () {
  function releaseStudentShell(reason) {
    var overlay = document.getElementById('app-loading-overlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    setTimeout(function () { if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 500);
    if (reason) console.warn('[student-shell] ' + reason);
  }
  window.addEventListener('error', function (event) {
    releaseStudentShell('脚本初始化异常');
  });
  window.addEventListener('unhandledrejection', function () {
    releaseStudentShell('初始化请求异常');
  });
  setTimeout(function () { releaseStudentShell('账号检测超时，已进入离线工作台'); }, 6500);
})();
