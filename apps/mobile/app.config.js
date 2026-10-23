// Adds what push alerts need on top of app.json, without putting anything secret in git:
// - google-services.json (Firebase, for Android push) is used when present next to this file or
//   named by GOOGLE_SERVICES_JSON; it is git-ignored.
// - EAS_PROJECT_ID is the Expo project the push tokens belong to.
// Without them the app still builds and runs; the alerts switch explains what is missing.
const fs = require('node:fs')
const path = require('node:path')

module.exports = ({ config }) => {
  const googleServices = process.env.GOOGLE_SERVICES_JSON || './google-services.json'
  const hasGoogleServices = fs.existsSync(path.resolve(__dirname, googleServices))
  const projectId = process.env.EAS_PROJECT_ID || config.extra?.eas?.projectId
  return {
    ...config,
    android: {
      ...config.android,
      ...(hasGoogleServices ? { googleServicesFile: googleServices } : {}),
    },
    plugins: [
      ...(config.plugins ?? []),
      ['expo-notifications', { color: '#e9a23b', defaultChannel: 'alerts' }],
    ],
    extra: {
      ...config.extra,
      ...(projectId ? { eas: { ...config.extra?.eas, projectId } } : {}),
    },
  }
}
