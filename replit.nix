{pkgs}: {
  deps = [
    pkgs.mesa
    pkgs.xorg.libxcb
    pkgs.xorg.libXrandr
    pkgs.xorg.libXfixes
    pkgs.xorg.libXext
    pkgs.xorg.libXdamage
    pkgs.xorg.libXcomposite
    pkgs.xorg.libX11
    pkgs.at-spi2-core
    pkgs.at-spi2-atk
    pkgs.dbus
    pkgs.alsa-lib
    pkgs.expat
    pkgs.gdk-pixbuf
    pkgs.cairo
    pkgs.pango
    pkgs.gtk3
    pkgs.libdrm
    pkgs.cups
    pkgs.atk
    pkgs.nspr
    pkgs.nss
    pkgs.glib
    pkgs.chromium
  ];
}
