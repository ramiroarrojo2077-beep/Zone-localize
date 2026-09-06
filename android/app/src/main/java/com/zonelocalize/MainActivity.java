package com.zonelocalize;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.webkit.WebViewAssetLoader;

/**
 * Envoltorio de la página en un WebView.
 *
 * Los archivos no se cargan con file://, que daría origen "null": ahí el navegador
 * bloquearía localStorage (donde vive la clave de API) y la llamada a la API de
 * Anthropic por CORS. En su lugar, WebViewAssetLoader los sirve desde un origen
 * https real, y todo se comporta como en un navegador común.
 */
public class MainActivity extends ComponentActivity {

    /** Origen virtual que atiende WebViewAssetLoader. No sale a la red. */
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + APP_HOST + "/index.html";

    private WebView web;
    private ValueCallback<Uri[]> pendingFiles;

    private final ActivityResultLauncher<Intent> filePicker = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> deliverFiles(WebChromeClient.FileChooserParams.parseResult(
                    result.getResultCode(), result.getData())));

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(APP_HOST)
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);   // localStorage: guarda la clave de API
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();

                // El mapa incrustado y demás subrecursos siguen dentro del WebView.
                if (!request.isForMainFrame() || APP_HOST.equals(url.getHost())) {
                    return false;
                }

                // Google Maps, Street View y OpenStreetMap se abren afuera,
                // en la app que corresponda.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (ActivityNotFoundException e) {
                    Toast.makeText(MainActivity.this,
                            "No hay ninguna app para abrir ese enlace", Toast.LENGTH_SHORT).show();
                }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view,
                                             ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                // Sin esto el botón de elegir foto no hace nada en un WebView.
                deliverFiles(null);
                pendingFiles = callback;
                try {
                    filePicker.launch(params.createIntent());
                    return true;
                } catch (ActivityNotFoundException e) {
                    pendingFiles = null;
                    Toast.makeText(MainActivity.this,
                            "No se encontró una app de galería", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (web.canGoBack()) {
                    web.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        });

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(START_URL);
        }
    }

    /** Cierra el pedido de archivos pendiente. Dejarlo colgado congela el input. */
    private void deliverFiles(Uri[] uris) {
        if (pendingFiles != null) {
            pendingFiles.onReceiveValue(uris);
            pendingFiles = null;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        deliverFiles(null);
        web.destroy();
        super.onDestroy();
    }
}
