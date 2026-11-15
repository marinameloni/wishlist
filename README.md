# 🎁 Wishlist

Application web auto-hébergée de listes de souhaits, pensée pour la famille.

## Fonctionnalités

- **Comptes famille** : nom + mot de passe uniquement. Chacun reste connecté 30 jours sur son appareil ;
  la session se renouvelle toute seule tant qu'on revient dans l'appli.
- **Inscription sur invitation** : le tout premier compte se crée librement, puis chaque membre peut copier
  le **lien d'invitation** (page Famille). Sans ce lien, impossible de créer un compte.
  Le lien peut être régénéré à tout moment ; l'ancien cesse alors de fonctionner.
- **Listes** avec icône, date d'événement (compte à rebours sur l'accueil) et description.
- **Toute la famille voit les listes de tout le monde** et peut **réserver** un cadeau (coche ✓).
  Un cadeau réservé ne peut pas l'être une deuxième fois, et seul celui qui a réservé peut annuler.
- **Mode surprise** (activé par défaut) : le propriétaire d'une liste ne voit pas ce qui a été réservé.
- **Ajout d'idées** : par lien (titre, image et prix récupérés automatiquement si le site le permet),
  ou à la main avec un **titre obligatoire** et une photo, un prix et une note facultatifs.
- **Bouton favori « ➕ Wishlist »** (page Profil) : à glisser dans la barre de favoris. Sur la page d'un produit,
  un clic reprend le titre, la photo et le prix, même sur les sites qui bloquent la lecture automatique (ex. Pimkie).
  ⚠️ Le bouton contient l'adresse de l'appli : réinstallez-le depuis la version en ligne une fois déployée.
- **Mes réservations** : tous les cadeaux que j'ai prévu d'offrir, regroupés par personne.
- **Recherche** dans toutes les listes + raccourcis vers Google Shopping, Amazon, Fnac, Leboncoin, Etsy.
- **Lien de partage** par liste pour les personnes sans compte (amis, collègues) : elles peuvent voir et réserver.
- Interface mobile (barre d'onglets en bas) et ordinateur, thème sombre automatique.

Stack : Node.js 24 + Express, base SQLite intégrée (`node:sqlite`), mots de passe hachés (scrypt),
sessions stockées en base. Les données (base + photos) sont dans le volume `/data`.

---

## Déploiement avec Portainer

### Option A : depuis un dépôt Git (recommandé)

1. Poussez ce dossier sur un dépôt GitHub/GitLab (il peut être privé).
2. Dans Portainer : **Stacks → Add stack → Repository**.
3. Indiquez l'URL du dépôt, la branche, et `docker-compose.yml` comme *Compose path*.
   Pour un dépôt privé, cochez *Authentication* et donnez un jeton d'accès.
4. **Deploy the stack**. Portainer construit l'image et lance le conteneur.
5. Ouvrez l'appli **tout de suite** et créez le premier compte : tant qu'aucun compte n'existe,
   n'importe qui atteignant l'adresse pourrait le créer.

Pour une mise à jour : poussez sur le dépôt, puis **Pull and redeploy** dans la stack.

### Option B : construire l'image sur le VPS

```bash
scp -r wishlist/ user@mon-vps:~/wishlist
```

```bash
ssh user@mon-vps "cd ~/wishlist && docker build -t wishlist:latest ."
```

Ensuite, dans Portainer : **Stacks → Add stack → Web editor**, collez ceci :

```yaml
services:
  wishlist:
    image: wishlist:latest
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      TZ: Europe/Paris
    volumes:
      - wishlist-data:/data
volumes:
  wishlist-data:
```

---

## Nom de domaine et HTTPS

L'appli écoute sur le port 3000. Placez-la derrière un reverse proxy (Nginx Proxy Manager, Traefik, Caddy)
pour avoir une adresse du type `https://cadeaux.mondomaine.fr`. **Le HTTPS est fortement conseillé**,
puisque des mots de passe transitent. Exemple avec Caddy :

```
cadeaux.mondomaine.fr {
  reverse_proxy wishlist:3000
}
```

Si le proxy est dans le même réseau Docker, vous pouvez retirer la section `ports`.

## Sauvegarde

Toutes les données sont dans le volume `wishlist-data` : `wishlist.db` pour la base, `uploads/` pour les photos.

```bash
docker run --rm -v wishlist_wishlist-data:/data -v $(pwd):/backup alpine tar czf /backup/wishlist-backup.tgz -C /data .
```

## Mot de passe oublié

Il n'y a pas d'e-mail, donc pas de lien de réinitialisation. Un membre peut supprimer le compte oublié
directement en base, puis renvoyer le lien d'invitation :

```bash
docker exec -it wishlist node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/wishlist.db').prepare('DELETE FROM users WHERE name=?').run(process.argv[1])" "Prénom"
```

⚠️ Cela supprime aussi les listes de cette personne.

## Lancer en local (développement)

```bash
npm install
```

```bash
node server.js
```

Ensuite, ouvrez http://localhost:3000.
