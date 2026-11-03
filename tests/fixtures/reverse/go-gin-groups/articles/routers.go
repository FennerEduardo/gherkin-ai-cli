package articles

import "github.com/gin-gonic/gin"

func ArticlesRegister(router *gin.RouterGroup) {
	router.GET("/:slug", ArticleRetrieve)
	router.PUT("/:slug", ArticleUpdate)
	router.PUT("/:slug/", ArticleUpdate)
}

func ArticleRetrieve(c *gin.Context) { c.JSON(200, gin.H{}) }

func ArticleUpdate(c *gin.Context) { c.JSON(200, gin.H{}) }
