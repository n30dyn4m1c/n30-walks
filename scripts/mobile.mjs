#!/usr/bin/env node
/**
 * One-command native setup:  npm run mobile:android   |   npm run mobile:ios
 *
 *  1. builds the web app
 *  2. creates the native project on first run (npx cap add <platform>)
 *  3. patches location / background permissions (idempotent)
 *  4. syncs web assets + plugins and opens Android Studio / Xcode
 *
 * Pass --no-open to skip opening the IDE (CI / headless).
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const platform = process.argv[2];
const open = !process.argv.includes('--no-open');
if (!['android', 'ios'].includes(platform)) {
  console.error('usage: node scripts/mobile.mjs <android|ios> [--no-open]');
  process.exit(1);
}
const run = (cmd) => { console.log(`\n$ ${cmd}`); execSync(cmd, { stdio: 'inherit' }); };

run('npm run build');
if (!fs.existsSync(platform)) run(`npx cap add ${platform}`);

if (platform === 'android') {
  const file = 'android/app/src/main/AndroidManifest.xml';
  let xml = fs.readFileSync(file, 'utf8');
  const perms = [
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_LOCATION',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.WAKE_LOCK',
  ];
  const missing = perms.filter((p) => !xml.includes(`"${p}"`));
  if (missing.length || !xml.includes('android.hardware.location.gps')) {
    const block = missing.map((p) => `    <uses-permission android:name="${p}" />`).join('\n') +
      (xml.includes('android.hardware.location.gps') ? '' : '\n    <uses-feature android:name="android.hardware.location.gps" android:required="false" />');
    xml = xml.replace(/(\s*<\/manifest>)/, `\n${block}$1`);
    fs.writeFileSync(file, xml);
    console.log(`patched ${file}: ${missing.join(', ') || 'gps feature'}`);
  }
  // Notification text shown while the foreground location service runs.
  const strings = 'android/app/src/main/res/values/strings.xml';
  let s = fs.readFileSync(strings, 'utf8');
  if (!s.includes('capacitor_background_geolocation_notification_channel_name')) {
    s = s.replace('</resources>', '    <string name="capacitor_background_geolocation_notification_channel_name">Walk recording</string>\n    <string name="capacitor_background_geolocation_notification_icon">ic_launcher</string>\n</resources>');
    fs.writeFileSync(strings, s);
  }
} else {
  const file = 'ios/App/App/Info.plist';
  let plist = fs.readFileSync(file, 'utf8');
  const add = {
    NSLocationWhenInUseUsageDescription: '<string>Stride uses your location to record the route, distance and pace of your walks.</string>',
    NSLocationAlwaysAndWhenInUseUsageDescription: '<string>Allow background location so Stride keeps recording your walk while the phone is locked.</string>',
    UIBackgroundModes: '<array><string>location</string></array>',
  };
  for (const [k, v] of Object.entries(add)) {
    if (!plist.includes(`<key>${k}</key>`)) plist = plist.replace(/<\/dict>\s*<\/plist>\s*$/, `\t<key>${k}</key>\n\t${v}\n</dict>\n</plist>\n`);
  }
  fs.writeFileSync(file, plist);
  console.log(`patched ${file}`);
}

run(`npx cap sync ${platform}`);
if (open) run(`npx cap open ${platform}`);
else console.log(`\nDone. Open the ${platform} project with: npx cap open ${platform}`);
