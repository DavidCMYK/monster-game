<?php
/*
Plugin Name: Monster Game (Embed Client)
Description: Embeds the Monster Battler HTML5 client via shortcode [monster_game].
Version: 1.0.0
Author: AI Dev
*/

if (!defined('ABSPATH')) { exit; }

function mg_enqueue_scripts() {
  $plugin_url = plugin_dir_url(__FILE__);
  wp_enqueue_style('mg-style', $plugin_url . 'client/style.css', array(), '1.0.0');
  wp_enqueue_script('mg-app', $plugin_url . 'client/app.js', array(), '1.0.0', true);
  // Pass endpoints from WP options, fallback to origin
  $api = get_option('mg_api_endpoint', site_url());
  $ws  = get_option('mg_ws_endpoint', 'ws://' . $_SERVER['HTTP_HOST'] . '/ws');
  wp_add_inline_script('mg-app', 'window.MGGameConfig = { api: "'.esc_js($api).'", ws: "'.esc_js($ws).'" };', 'before');
}
add_action('wp_enqueue_scripts', 'mg_enqueue_scripts');

function mg_shortcode() {
  ob_start();
  ?>
  <div id="mg-game-container">
    <div class="panel" id="auth">
      <h1>Monster Battler</h1>
      <input id="email" placeholder="Email" />
      <input id="password" placeholder="Password" type="password" />
      <input id="handle" placeholder="Handle (register only)" />
      <div class="row">
        <button id="btnRegister">Register</button>
        <button id="btnLogin">Login</button>
      </div>
      <div id="authMsg"></div>
    </div>
    <canvas id="view" width="640" height="480" style="display:none;"></canvas>
  </div>
  <?php
  return ob_get_clean();
}
add_shortcode('monster_game', 'mg_shortcode');

// Settings Page
function mg_register_settings() {
  add_options_page('Monster Game', 'Monster Game', 'manage_options', 'monster-game', 'mg_settings_page');
  register_setting('mg_settings_group', 'mg_api_endpoint');
  register_setting('mg_settings_group', 'mg_ws_endpoint');
}
add_action('admin_menu', 'mg_register_settings');

function mg_settings_page(){
  ?>
  <div class="wrap">
    <h1>Monster Game Settings</h1>
    <form method="post" action="options.php">
      <?php settings_fields('mg_settings_group'); do_settings_sections('mg_settings_group'); ?>
      <table class="form-table">
        <tr><th scope="row">API Endpoint</th><td><input type="text" name="mg_api_endpoint" value="<?php echo esc_attr(get_option('mg_api_endpoint', site_url())); ?>" size="60"/></td></tr>
        <tr><th scope="row">WebSocket Endpoint</th><td><input type="text" name="mg_ws_endpoint" value="<?php echo esc_attr(get_option('mg_ws_endpoint', 'ws://' . $_SERVER['HTTP_HOST'] . '/ws')); ?>" size="60"/></td></tr>
      </table>
      <?php submit_button(); ?>
    </form>
  </div>
  <?php
}
