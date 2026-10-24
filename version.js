/* MultiPass — single global version constant (CountMeIn / ShortRack version.js pattern).
   Deploy: bump here → git push → poll the served version.js → UPDATE apa_core.apps SET version=$NEW
   WHERE app_name='MultiPass' (or 'MultiPass-preprod' for the preprod page) — serve-then-bump, reference_deploy.md.
   Scheme starts at 1.0 so a parseFloat compare never meets the 0.10 < 0.9 trap. */
window.APP_VERSION = '1.4';
