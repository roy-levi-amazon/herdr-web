package dev.herdr.web;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int APP_BACKGROUND_COLOR = Color.rgb(17, 17, 27);

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(APP_BACKGROUND_COLOR);
        getWindow().setNavigationBarColor(APP_BACKGROUND_COLOR);
        getWindow().getDecorView().setBackgroundColor(APP_BACKGROUND_COLOR);

        View content = findViewById(android.R.id.content);
        content.setBackgroundColor(APP_BACKGROUND_COLOR);
        ViewCompat.setOnApplyWindowInsetsListener(content, (view, windowInsets) -> {
            Insets insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            boolean keyboardVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime());
            int bottomInset = keyboardVisible ? 0 : insets.bottom;
            view.setPadding(insets.left, insets.top, insets.right, bottomInset);
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(content);
    }
}
