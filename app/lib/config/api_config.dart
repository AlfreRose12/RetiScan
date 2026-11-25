// Configuración global de la API RetiScan
// La URL base se deriva automáticamente del host desde el que se sirve la app,
// por lo que funciona con cualquier IP sin necesidad de recompilar.

import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:http/browser_client.dart';
import '../services/auth_service.dart';
// ignore: avoid_web_libraries_in_flutter
import 'dart:html' as html;

class ApiConfig {
  /// URL opcional inyectada en tiempo de compilación:
  /// flutter build web --release --dart-define=API_URL=https://mi-api.up.railway.app
  static const String _envApiUrl = String.fromEnvironment('API_URL', defaultValue: '');

  /// Construye la URL base de la API a partir de API_URL (si se definió en build)
  /// o del hostname actual.
  static String get baseUrl {
    final configured = _envApiUrl.trim().replaceAll(RegExp(r'/+$'), '');
    if (configured.isNotEmpty) {
      return configured.endsWith('/api') ? configured : '$configured/api';
    }

    final host = html.window.location.hostname ?? 'localhost';
    final protocol = html.window.location.protocol; // 'https:' o 'http:'

    // Si estamos en local / desarrollo
    if (host == 'localhost' || host == '127.0.0.1' || host.startsWith('192.168.')) {
      return 'http://$host:3000/api';
    }

    // Si estamos desplegando en Railway sin API_URL configurada
    if (host.contains('railway.app')) {
      return 'https://retiscan-production.up.railway.app/api';
    }

    // Dominio personalizado de producción (ej: app.retiscan.online -> api.retiscan.online)
    final apiHost = host.replaceAll('app.', 'api.');
    return 'https://$apiHost/api';
  }

  static String imageUrl(String? uri) {
    if (uri == null || uri.isEmpty) return '';
    if (uri.startsWith('http://') || uri.startsWith('https://')) {
      return uri;
    }
    final path = uri.startsWith('/') ? uri : '/$uri';
    return '${baseUrl.replaceFirst(RegExp(r'/api$'), '')}$path';
  }

  // Headers para requests autenticados (usado internamente o legacy)
  static Map<String, String> authHeaders(String token) => {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $token',
      };

  // Headers para requests públicos
  static const Map<String, String> jsonHeaders = {
    'Content-Type': 'application/json',
  };

  // CLIENTE HTTP GLOBAL W/ CREDENTIALS & AUTO-REFRESH (Interceptor)
  static http.Client? _cachedClient;
  static http.Client get _baseClient {
    _cachedClient ??= BrowserClient()..withCredentials = true;
    return _cachedClient!;
  }

  static Future<http.Response> request(
    String method,
    String endpoint, {
    dynamic body, // Puede ser Map<String, dynamic> o String encodado
    bool requiresAuth = true,
  }) async {
    final uri = Uri.parse(baseUrl + endpoint);
    var token = AuthService().token;
    var headers = (requiresAuth && token != null) ? authHeaders(token) : jsonHeaders;

    http.Response response = await _sendRequest(method, uri, headers, body);

    // Interceptor: Si expira el token, intenta Refresh
    if (response.statusCode == 401 && requiresAuth) {
      final authOk = await AuthService().doRefresh();
      if (authOk) {
        token = AuthService().token;
        headers = authHeaders(token!);
        response = await _sendRequest(method, uri, headers, body);
      } else {
        AuthService().clearStorage();
      }
    }
    return response;
  }

  static Future<http.Response> _sendRequest(String m, Uri u, Map<String, String> h, dynamic b) async {
    final client = _baseClient;
    final encoded = b is Map ? jsonEncode(b) : b; // codifica si es mapa, literal si es string
    switch (m) {
      case 'POST':   return client.post(u, headers: h, body: encoded);
      case 'PUT':    return client.put(u, headers: h, body: encoded);
      case 'PATCH':  return client.patch(u, headers: h, body: encoded);
      case 'DELETE': return client.delete(u, headers: h, body: encoded);
      case 'GET':
      default:       return client.get(u, headers: h);
    }
  }

  // Wrappers directos
  static Future<http.Response> get(String endpoint) => request('GET', endpoint);
  static Future<http.Response> post(String endpoint, {dynamic body}) => request('POST', endpoint, body: body);
  static Future<http.Response> put(String endpoint, {dynamic body})  => request('PUT', endpoint, body: body);
  static Future<http.Response> patch(String endpoint, {dynamic body}) => request('PATCH', endpoint, body: body);
  static Future<http.Response> delete(String endpoint, {dynamic body}) => request('DELETE', endpoint, body: body);
}

