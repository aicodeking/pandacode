# Adds a light Xfce desktop with automatic login to a console-only Linux VM, so agents
# can use it with computer use. Debian/Ubuntu (apt) and Fedora (dnf).
set -eu
restart=0
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  sudo -E apt-get update -qq
  sudo -E apt-get install -y -qq --no-install-recommends xfce4 xfce4-terminal lightdm lightdm-gtk-greeter \
    dbus-x11 xserver-xorg-core xserver-xorg-video-fbdev xserver-xorg-input-libinput x11-xserver-utils \
    fonts-dejavu-core at-spi2-core xdg-utils >/dev/null
  # Debian's cloud kernel has no display driver: boot the generic one when this is done.
  # Both are the same version, so GRUB has to be told which.
  if ! sudo modinfo -n virtio_gpu >/dev/null 2>&1; then
    sudo -E apt-get install -y -qq --no-install-recommends "linux-image-$(dpkg --print-architecture)" >/dev/null
    printf 'GRUB_TOP_LEVEL=%s\n' "$(ls -v /boot/vmlinuz-* | grep -v cloud | tail -1)" | sudo tee /etc/default/grub.d/90-pandacode.cfg >/dev/null
    sudo update-grub 2>/dev/null
    restart=1
  fi
elif command -v dnf >/dev/null 2>&1; then
  sudo dnf install -y -q xfce4-session xfwm4 xfdesktop xfce4-panel xfce4-terminal thunar lightdm lightdm-gtk \
    xorg-x11-server-Xorg xorg-x11-drv-libinput dejavu-sans-fonts >/dev/null
else
  echo "This Linux VM has no apt or dnf; install a desktop yourself." >&2
  exit 2
fi
sudo mkdir -p /etc/lightdm/lightdm.conf.d
printf '[Seat:*]\nautologin-user=%s\nautologin-session=xfce\nuser-session=xfce\n' "$(id -un)" | sudo tee /etc/lightdm/lightdm.conf.d/50-pandacode.conf >/dev/null
getent group autologin >/dev/null || sudo groupadd -r autologin
sudo usermod -aG autologin "$(id -un)"
# Never blank or lock the screen an agent is looking at.
mkdir -p ~/.config/autostart
printf '[Desktop Entry]\nType=Application\nName=PandaCode screen\nExec=sh -c "xset s off -dpms"\n' > ~/.config/autostart/pandacode-screen.desktop
sudo systemctl set-default graphical.target >/dev/null
sudo systemctl enable lightdm >/dev/null 2>&1 || true
if [ "$restart" = 1 ]; then
  sudo systemd-run --quiet --on-active=3 systemctl reboot
else
  sudo systemctl restart lightdm 2>/dev/null || sudo systemctl start display-manager
fi
echo "Desktop ready."
