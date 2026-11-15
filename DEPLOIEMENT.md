# Déployer Wishlist avec Portainer (sans Git ni SSH)

## 1. Construire l'image

1. Portainer → choisissez votre environnement → **Images** → **Build a new image**.
2. **Image name** : `wishlist:latest`
3. Méthode : **Upload** → sélectionnez `wishlist-portainer.tar` (dans ce dossier).
   Laissez *Dockerfile path* sur `Dockerfile`.
4. **Build the image** et attendez la fin (1 à 2 minutes : Node est téléchargé puis les dépendances installées).
   L'onglet *Output* doit se terminer sans erreur.

## 2. Lancer la stack

1. **Stacks** → **Add stack** → nom : `wishlist` → **Web editor**.
2. Collez le contenu de `portainer-stack.yml`.
3. **Deploy the stack**.
4. Testez : `http://IP-DU-VPS:3080`. L'écran « Créez le premier compte » doit apparaître.

> ⚠️ Ne créez pas encore votre compte via `http://` si l'appli est exposée sur internet :
> branchez d'abord le HTTPS (étape 3), puis créez le compte **immédiatement**, car le
> premier compte peut être créé par n'importe qui tant qu'il n'existe pas.

## 3. Brancher le nom de domaine (HTTPS)

Créez d'abord un enregistrement DNS (ex. `cadeaux.mondomaine.fr`) qui pointe vers l'IP du VPS.

**Nginx Proxy Manager** : *Proxy Hosts* → *Add Proxy Host*
- Domain : `cadeaux.mondomaine.fr`
- Scheme `http`, Forward Hostname `wishlist`, Port `3000`
  (si NPM n'est pas dans le même réseau Docker : l'IP du VPS et le port 3080)
- Onglet SSL : *Request a new SSL certificate*, cochez *Force SSL*.

**Traefik** : ajoutez au service dans la stack (et le réseau de Traefik) :
```yaml
    labels:
      - traefik.enable=true
      - traefik.http.routers.wishlist.rule=Host(`cadeaux.mondomaine.fr`)
      - traefik.http.routers.wishlist.entrypoints=websecure
      - traefik.http.routers.wishlist.tls.certresolver=letsencrypt
      - traefik.http.services.wishlist.loadbalancer.server.port=3000
```
(adaptez `websecure` et `letsencrypt` aux noms utilisés dans votre config Traefik)

**Caddy** :
```
cadeaux.mondomaine.fr {
  reverse_proxy wishlist:3000
}
```

Quand le proxy et l'appli sont dans le même réseau Docker, décommentez la partie `networks`
de la stack et supprimez la section `ports` : l'appli n'est alors plus accessible en direct sur le port 3080.

## 4. Après le déploiement

1. Ouvrez `https://cadeaux.mondomaine.fr` et **créez votre compte tout de suite**.
2. Page **Famille** → copiez le lien d'invitation et envoyez-le à la famille.
3. Page **Profil** → réinstallez le bouton « + Wishlist » dans vos favoris
   (celui installé en local pointe vers `localhost`).

## Mettre à jour l'appli plus tard

1. Je régénère `wishlist-portainer.tar`.
2. Portainer → **Images** → **Build a new image** avec le même nom `wishlist:latest` → Upload.
3. **Stacks** → `wishlist` → **Update the stack**, ou **Containers** → `wishlist` → **Recreate**.
   Les données restent dans le volume `wishlist-data`.
