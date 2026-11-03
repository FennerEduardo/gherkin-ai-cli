// Routes registered by functions in other packages on groups handed over by main (gin), the way the
// RealWorld gin app does it (scripts/reverse-oss.js).
package main

import (
	"github.com/gin-gonic/gin"

	"example.com/gingroups/articles"
	"example.com/gingroups/users"
)

func main() {
	r := gin.Default()
	v1 := r.Group("/api")
	users.UsersRegister(v1.Group("/users"))
	articles.ArticlesRegister(v1.Group("/articles"))
	health := r.Group("/api/ping")
	health.GET("/", func(c *gin.Context) { c.JSON(200, gin.H{"message": "pong"}) })
	_ = r.Run(":8080")
}
