// Native-only plugin: window.Capacitor.Plugins.KesherNotify
//   .configure({ base, key, live, push }) → { permission, live, push }
//   .status() → { permission, live, connected, push, distributor }
//   .askPermission() → the same state, after Android's question; .setLive({ live }) → the app's own switch
//   .clear({ id }), .takeOpen() → { path }, and the "open" event ({ path }) when a notification is tapped.
